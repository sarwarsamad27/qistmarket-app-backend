const prisma = require('../../lib/prisma');
const { getOutletFilter } = require('../utils/outletFilter');
const { logAction } = require('../utils/auditLogger');

const AGING_BUCKETS = ['0-30', '31-60', '61-90', '90+'];
const bucketFor = (daysOverdue) => {
    if (daysOverdue <= 30) return '0-30';
    if (daysOverdue <= 60) return '31-60';
    if (daysOverdue <= 90) return '61-90';
    return '90+';
};
const emptyBuckets = () => ({ '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 });

/**
 * createHeadOfficeVendor
 * Same shape as vendorController.createVendor but not tied to req.user's
 * outlet_id — lets an Accountant register a vendor managed at HQ level
 * (a national supplier, not one specific outlet's local vendor).
 */
const createHeadOfficeVendor = async (req, res) => {
    try {
        const { name, phone, email, address, outlet_id } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'Vendor name is required.' });

        const vendor = await prisma.vendor.create({
            data: { name, phone: phone || null, email: email || null, address: address || null, outlet_id: outlet_id ? parseInt(outlet_id) : null },
        });

        await logAction(req, 'VENDOR_CREATED', `${outlet_id ? 'Outlet' : 'Head Office'} vendor "${vendor.name}" created.`, vendor.id, 'Vendor');

        res.status(201).json({ success: true, data: vendor });
    } catch (error) {
        console.error('createHeadOfficeVendor error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * recordVendorCashTransaction
 * Tracks a vendor's own running cash-in-hand balance (distinct from what
 * we owe them on purchases) — e.g. cash advanced to or held by a vendor.
 */
const recordVendorCashTransaction = async (req, res) => {
    try {
        const { vendor_id, type, amount, description } = req.body;
        if (!vendor_id || !['credit', 'debit'].includes(type) || !amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'vendor_id, a valid type (credit/debit), and a positive amount are required.' });
        }
        const parsedAmount = parseFloat(amount);

        const result = await prisma.$transaction(async (tx) => {
            const vendor = await tx.vendor.findUnique({ where: { id: parseInt(vendor_id) } });
            if (!vendor) throw new Error('Vendor not found.');

            const balanceAfter = type === 'credit' ? vendor.cash_in_hand_balance + parsedAmount : vendor.cash_in_hand_balance - parsedAmount;

            const transaction = await tx.vendorCashTransaction.create({
                data: { vendor_id: vendor.id, type, amount: parsedAmount, balance_after: balanceAfter, description: description || null, created_by_id: req.user.id },
            });
            await tx.vendor.update({ where: { id: vendor.id }, data: { cash_in_hand_balance: balanceAfter } });

            return { transaction, balanceAfter };
        });

        await logAction(req, 'VENDOR_CASH_TRANSACTION', `${type === 'credit' ? 'Credited' : 'Debited'} PKR ${parsedAmount} on vendor #${vendor_id}'s cash-in-hand.`, result.transaction.id, 'VendorCashTransaction');

        res.status(201).json({ success: true, data: result });
    } catch (error) {
        console.error('recordVendorCashTransaction error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};

const getVendorCashLedger = async (req, res) => {
    try {
        const { vendor_id } = req.params;
        const vendor = await prisma.vendor.findUnique({ where: { id: parseInt(vendor_id) } });
        if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found.' });

        const transactions = await prisma.vendorCashTransaction.findMany({
            where: { vendor_id: parseInt(vendor_id) },
            include: { created_by: { select: { full_name: true } } },
            orderBy: { created_at: 'desc' },
        });

        res.json({ success: true, data: { vendor, transactions } });
    } catch (error) {
        console.error('getVendorCashLedger error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getVendorAgingReport
 * Buckets outstanding VendorPurchase balances by days past due_date —
 * the payables-side counterpart to accountsController.getInstallmentAging.
 */
const getVendorAgingReport = async (req, res) => {
    const outletFilter = getOutletFilter(req);

    try {
        const purchases = await prisma.vendorPurchase.findMany({
            where: { ...outletFilter, balance: { gt: 0 } },
            include: { outlet: { select: { name: true } }, vendor: { select: { id: true, name: true } } },
        });

        const today = new Date();
        const buckets = emptyBuckets();
        const vendorMap = {};
        const items = [];

        for (const p of purchases) {
            const dueDate = p.due_date ? new Date(p.due_date) : new Date(p.purchase_date);
            const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
            const bucket = bucketFor(Math.max(0, daysOverdue));
            buckets[bucket] += p.balance;

            const vendorKey = p.vendor_id ?? p.vendor_name;
            if (!vendorMap[vendorKey]) vendorMap[vendorKey] = { vendor_id: p.vendor_id, vendor_name: p.vendor?.name || p.vendor_name, ...emptyBuckets(), total: 0 };
            vendorMap[vendorKey][bucket] += p.balance;
            vendorMap[vendorKey].total += p.balance;

            items.push({
                purchase_id: p.id, invoice_number: p.invoice_number, vendor_name: p.vendor?.name || p.vendor_name,
                outlet_name: p.outlet?.name, due_date: p.due_date, daysOverdue: Math.max(0, daysOverdue), bucket, balance: p.balance,
            });
        }

        items.sort((a, b) => b.daysOverdue - a.daysOverdue);

        res.json({
            success: true,
            data: {
                buckets,
                total: AGING_BUCKETS.reduce((acc, b) => acc + buckets[b], 0),
                vendorWise: Object.values(vendorMap).sort((a, b) => b.total - a.total),
                items,
            },
        });
    } catch (error) {
        console.error('getVendorAgingReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getVendorDueAlerts
 * Purchases due within the next N days (or already overdue) — the "due
 * alerts" surface for vendor payables.
 */
const getVendorDueAlerts = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const withinDays = parseInt(req.query.withinDays) || 7;

    try {
        const horizon = new Date();
        horizon.setDate(horizon.getDate() + withinDays);

        const purchases = await prisma.vendorPurchase.findMany({
            where: { ...outletFilter, balance: { gt: 0 }, due_date: { lte: horizon } },
            include: { vendor: { select: { name: true } }, outlet: { select: { name: true } } },
            orderBy: { due_date: 'asc' },
        });

        const today = new Date();
        res.json({
            success: true,
            data: purchases.map((p) => ({
                purchase_id: p.id, invoice_number: p.invoice_number, vendor_name: p.vendor?.name || p.vendor_name,
                outlet_name: p.outlet?.name, due_date: p.due_date, balance: p.balance,
                isOverdue: p.due_date ? new Date(p.due_date) < today : false,
            })),
        });
    } catch (error) {
        console.error('getVendorDueAlerts error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const createScheduledPayment = async (req, res) => {
    try {
        const { vendor_id, amount, scheduled_date, notes } = req.body;
        if (!vendor_id || !amount || !scheduled_date) {
            return res.status(400).json({ success: false, message: 'vendor_id, amount, and scheduled_date are required.' });
        }

        const payment = await prisma.scheduledPayment.create({
            data: { vendor_id: parseInt(vendor_id), amount: parseFloat(amount), scheduled_date: new Date(scheduled_date), notes: notes || null, created_by_id: req.user.id },
        });

        await logAction(req, 'VENDOR_PAYMENT_SCHEDULED', `PKR ${amount} scheduled for vendor #${vendor_id} on ${scheduled_date}.`, payment.id, 'ScheduledPayment');

        res.status(201).json({ success: true, data: payment });
    } catch (error) {
        console.error('createScheduledPayment error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getScheduledPayments = async (req, res) => {
    try {
        const { status } = req.query;
        const payments = await prisma.scheduledPayment.findMany({
            where: status ? { status } : {},
            include: { vendor: { select: { name: true } } },
            orderBy: { scheduled_date: 'asc' },
        });
        res.json({ success: true, data: payments });
    } catch (error) {
        console.error('getScheduledPayments error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const updateScheduledPaymentStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        if (!['scheduled', 'paid', 'cancelled'].includes(status)) {
            return res.status(400).json({ success: false, message: 'status must be scheduled, paid, or cancelled.' });
        }
        const payment = await prisma.scheduledPayment.update({ where: { id: parseInt(id) }, data: { status } });
        res.json({ success: true, data: payment });
    } catch (error) {
        console.error('updateScheduledPaymentStatus error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    createHeadOfficeVendor,
    recordVendorCashTransaction,
    getVendorCashLedger,
    getVendorAgingReport,
    getVendorDueAlerts,
    createScheduledPayment,
    getScheduledPayments,
    updateScheduledPaymentStatus,
};
