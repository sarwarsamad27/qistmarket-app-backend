const prisma = require('../../lib/prisma');
const { getOutletFilter } = require('../utils/outletFilter');

/**
 * getDaybook
 * Aggregates all financial movements for the outlet on a specific date/range.
 */
const getDaybook = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { startDate, endDate } = req.query;

    try {
        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        } else if (startDate) {
            const end = new Date(startDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        } else {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            dateFilter.gte = today;
            const end = new Date();
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }

        // 1. Fetch Ledgers (Real-time income)
        const ledgers = await prisma.installmentLedger.findMany({
            where: {
                order: outletFilter,
            },
        });

        const payments = [];
        let totalIncome = 0;
        let totalAdvance = 0;
        let totalInstallments = 0;

        for (const ledger of ledgers) {
            const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
            for (const row of rows) {
                if (row.status === 'paid' && row.paid_at) {
                    const paidDate = new Date(row.paid_at);
                    if (paidDate >= dateFilter.gte && paidDate <= dateFilter.lte) {
                        const amount = parseFloat(row.amount || row.dueAmount || 0);
                        totalIncome += amount;
                        if (row.month === 0) totalAdvance += amount;
                        else totalInstallments += amount;

                        payments.push({
                            ...row,
                            paymentType: row.month === 0 ? 'advance' : 'installment',
                            amount: amount,
                            paidAt: row.paid_at
                        });
                    }
                }
            }
        }

        // 2. Fetch Expenses (Real-time outgoing)
        const expenses = await prisma.expense.findMany({
            where: {
                ...outletFilter,
                created_at: dateFilter
            }
        });

        // 3. Summarize
        const summary = {
            totalIncome,
            totalExpense: expenses.reduce((acc, e) => acc + e.amount, 0),
            netCash: 0,
            breakdown: {
                advance: totalAdvance,
                installments: totalInstallments,
            }
        };
        summary.netCash = summary.totalIncome - summary.totalExpense;

        res.json({ success: true, data: { summary, payments, expenses } });
    } catch (error) {
        console.error('getDaybook error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getStockSummary
 * Summary of inventory items in the outlet.
 */
const getStockSummary = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { startDate, endDate } = req.query;

    try {
        const inventory = await prisma.outletInventory.findMany({
            where: outletFilter
        });

        // Filter sold items by date if dates provided
        // We'd typically need the sale date, but currently outletInventory status just says "Sold"
        // Let's assume updated_at represents the sale date for "Sold" items
        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }

        const summary = inventory.reduce((acc, item) => {
            let includeSold = true;
            if (item.status === 'Sold' && (dateFilter.gte || dateFilter.lte)) {
                const updatedDate = new Date(item.updated_at);
                if (dateFilter.gte && updatedDate < dateFilter.gte) includeSold = false;
                if (dateFilter.lte && updatedDate > dateFilter.lte) includeSold = false;
            }

            const key = item.product_name;
            if (!acc[key]) {
                acc[key] = {
                    product: key,
                    total: 0,
                    inStock: 0,
                    sold: 0,
                    valuation: 0
                };
            }
            
            // Only count if it's in stock or it's sold within the date range (or no date filter)
            if (item.status === 'In Stock') {
                acc[key].total++;
                acc[key].inStock++;
                acc[key].valuation += item.purchase_price;
            } else if (item.status === 'Sold' && includeSold) {
                acc[key].total++;
                acc[key].sold++;
                acc[key].valuation += item.purchase_price; // Value of what we had/sold
            }
            
            return acc;
        }, {});

        res.json({ success: true, data: Object.values(summary) });
    } catch (error) {
        console.error('getStockSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getSalesReport
 * Detailed list of sales/orders for the outlet.
 */
const getSalesReport = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { startDate, endDate } = req.query;

    try {
        // Sales Report only shows delivered orders
        const where = { ...outletFilter, status: 'delivered' };

        if (startDate || endDate) {
            where.updated_at = {};
            if (startDate) where.updated_at.gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                where.updated_at.lte = end;
            }
        }

        const orders = await prisma.order.findMany({
            where,
            include: {
                installment_ledger: true
            },
            orderBy: { updated_at: 'desc' }
        });

        const summary = {
            totalOrders: orders.length,
            totalGrossAmount: orders.reduce((acc, o) => acc + o.total_amount, 0),
            totalReceived: orders.reduce((acc, o) => {
                const rows = Array.isArray(o.installment_ledger?.ledger_rows) ? o.installment_ledger.ledger_rows : [];
                return acc + rows.filter(r => r.status === 'paid').reduce((pAcc, p) => pAcc + (p.amount || 0), 0);
            }, 0)
        };

        res.json({ success: true, data: { summary, orders } });
    } catch (error) {
        console.error('getSalesReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getProfitLoss
 */
const getProfitLoss = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { startDate, endDate } = req.query;

    try {
        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }

        // 1. Fetch Ledgers in the range (Actual cash inflow)
        const ledgers = await prisma.installmentLedger.findMany({
            where: {
                order: outletFilter,
            },
        });

        let totalRevenue = 0;
        for (const ledger of ledgers) {
            const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
            for (const row of rows) {
                if (row.status === 'paid' && row.paid_at) {
                    const paidDate = new Date(row.paid_at);
                    if (paidDate >= dateFilter.gte && paidDate <= (dateFilter.lte || new Date())) {
                        totalRevenue += parseFloat(row.amount || row.dueAmount || 0);
                    }
                }
            }
        }

        // 2. Find Orders in the range for COGS (Only DELIVERED orders)
        const orders = await prisma.order.findMany({
            where: {
                ...outletFilter,
                updated_at: dateFilter, // Use updated_at for delivery date approximation
                is_delivered: true
            },
            select: {
                imei_serial: true
            }
        });
        
        // 2. Find purchase prices for these items
        const imeiSerials = orders.map(o => o.imei_serial).filter(Boolean);
        const inventoryItems = await prisma.outletInventory.findMany({
            where: {
                imei_serial: { in: imeiSerials }
            },
            select: {
                purchase_price: true
            }
        });

        const totalCOGS = inventoryItems.reduce((acc, item) => acc + item.purchase_price, 0);
        const grossProfit = totalRevenue - totalCOGS;

        // 3. Subtract Expenses
        const expensesAgg = await prisma.expense.aggregate({
            where: { ...outletFilter, created_at: dateFilter },
            _sum: { amount: true }
        });
        const totalExpenses = expensesAgg._sum.amount || 0;

        res.json({
            success: true,
            data: {
                revenue: totalRevenue,
                cogs: totalCOGS,
                grossProfit,
                expenses: totalExpenses,
                netProfit: grossProfit - totalExpenses,
                orderCount: orders.length
            }
        });
    } catch (error) {
        console.error('getProfitLoss error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getCustomerLedger
 */
const getCustomerLedger = async (req, res) => {
    const { phone } = req.params;
    const outletFilter = getOutletFilter(req);

    try {
        const orders = await prisma.order.findMany({
            where: {
                whatsapp_number: phone,
                ...outletFilter
            },
            include: {
                installment_ledger: true
            },
            orderBy: { created_at: 'desc' }
        });

        // Map installments for backward compatibility with the frontend if needed
        const mappedOrders = orders.map(order => {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            return {
                ...order,
                payments: rows.filter(r => r.status === 'paid').map(r => ({
                    paymentType: r.month === 0 ? 'advance' : 'installment',
                    amount: r.amount || 0,
                    created_at: r.paid_at || order.created_at,
                    method: r.payment_method
                }))
            };
        });

        res.json({ success: true, data: mappedOrders });
    } catch (error) {
        console.error('getCustomerLedger error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getRecoveryReport
 */
const getRecoveryReport = async (req, res) => {
    const outletFilter = getOutletFilter(req);

    try {
        const orders = await prisma.order.findMany({
            where: {
                ...outletFilter,
                status: { notIn: ['Cancelled', 'Rejected'] }
            },
            include: {
                installment_ledger: true
            }
        });

        const recoveryList = orders.map(order => {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            const totalPaid = rows.filter(r => r.status === 'paid').reduce((acc, p) => acc + (p.amount || 0), 0);
            const balance = order.total_amount - totalPaid;
            return {
                order_id: order.id,
                order_ref: order.order_ref,
                customer: order.customer_name,
                phone: order.whatsapp_number,
                total_amount: order.total_amount,
                total_paid: totalPaid,
                balance
            };
        }).filter(item => item.balance > 0);

        res.json({ success: true, data: recoveryList });
    } catch (error) {
        console.error('getRecoveryReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getAllOutlets
 * Simple helper for admin selector
 */
const getAllOutlets = async (req, res) => {
    try {
        const outlets = await prisma.outlet.findMany({
            select: { id: true, name: true, city: true }
        });
        res.json({ success: true, data: outlets });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching outlets' });
    }
};

/**
 * getFinancialReport
 * Aggregates both Expense and VendorPayment models to show cash out-flow.
 */
const getFinancialReport = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { startDate, endDate } = req.query;

    try {
        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }

        const expenses = await prisma.expenseVoucher.findMany({
            where: {
                ...outletFilter,
                ...(Object.keys(dateFilter).length > 0 && { date: dateFilter })
            },
            include: { items: true },
            orderBy: { date: 'desc' }
        });

        const vendorPayments = await prisma.vendorPayment.findMany({
            where: {
                ...outletFilter,
                ...(Object.keys(dateFilter).length > 0 && { created_at: dateFilter })
            },
            include: { vendor: true },
            orderBy: { created_at: 'desc' }
        });

        res.json({ success: true, data: { expenses, vendorPayments } });
    } catch (error) {
        console.error('getFinancialReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getInstallmentRecoveriesReport
 * Filters installment_ledger rows where status = paid yielding pure cash inflows.
 */
const getInstallmentRecoveriesReport = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { startDate, endDate } = req.query;

    try {
        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }

        const ledgers = await prisma.installmentLedger.findMany({
            where: {
                order: { ...outletFilter, status: { notIn: ['Cancelled', 'Rejected'] } }
            },
            include: {
                order: { select: { order_ref: true, customer_name: true, whatsapp_number: true, id: true } }
            }
        });

        let recoveries = [];
        let totalRecovered = 0;

        for (const ledger of ledgers) {
            const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
            for (const row of rows) {
                if (row.status === 'paid' && row.paid_at) {
                    const paidDate = new Date(row.paid_at);
                    let include = true;
                    if (dateFilter.gte && paidDate < dateFilter.gte) include = false;
                    if (dateFilter.lte && paidDate > dateFilter.lte) include = false;

                    if (include) {
                        const amount = parseFloat(row.amount || row.dueAmount || 0);
                        totalRecovered += amount;
                        recoveries.push({
                            order_id: ledger.order.id,
                            order_ref: ledger.order.order_ref,
                            customer_name: ledger.order.customer_name,
                            whatsapp_number: ledger.order.whatsapp_number,
                            amount: amount,
                            month: row.month,
                            label: row.label || `Month ${row.month}`,
                            paid_at: row.paid_at,
                            payment_method: row.payment_method || 'Cash'
                        });
                    }
                }
            }
        }
        
        // Sort by paid_at descending
        recoveries.sort((a, b) => new Date(b.paid_at) - new Date(a.paid_at));

        res.json({ success: true, data: { recoveries, totalRecovered } });
    } catch (error) {
        console.error('getInstallmentRecoveriesReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getOfficerRecoveryReport
 * Performance of recovery officers assigned to the outlet.
 */
const getOfficerRecoveryReport = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { startDate, endDate } = req.query;

    try {
        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }

        // We fetch all orders that have a recovery_officer_id and are in this outlet
        const orders = await prisma.order.findMany({
            where: {
                ...outletFilter,
                recovery_officer_id: { not: null },
                status: { notIn: ['Cancelled', 'Rejected'] }
            },
            include: {
                recovery_officer: { select: { id: true, full_name: true, phone: true } },
                installment_ledger: true
            }
        });

        const officerMap = {};

        for (const order of orders) {
            const officerId = order.recovery_officer_id;
            const officer = order.recovery_officer;
            if (!officerId || !officer) continue;

            if (!officerMap[officerId]) {
                officerMap[officerId] = {
                    officer_id: officerId,
                    officer_name: officer.full_name,
                    officer_phone: officer.phone,
                    assigned_orders: 0,
                    total_recovered: 0,
                    recoveries: []
                };
            }

            officerMap[officerId].assigned_orders += 1;

            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            for (const row of rows) {
                if (row.status === 'paid' && row.paid_at) {
                    const paidDate = new Date(row.paid_at);
                    let include = true;
                    if (dateFilter.gte && paidDate < dateFilter.gte) include = false;
                    if (dateFilter.lte && paidDate > dateFilter.lte) include = false;

                    if (include) {
                        const amount = parseFloat(row.amount || row.dueAmount || 0);
                        officerMap[officerId].total_recovered += amount;
                        officerMap[officerId].recoveries.push({
                            order_id: order.id,
                            order_ref: order.order_ref,
                            amount: amount,
                            paid_at: row.paid_at
                        });
                    }
                }
            }
        }

        res.json({ success: true, data: Object.values(officerMap) });
    } catch (error) {
        console.error('getOfficerRecoveryReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getDaybook,
    getStockSummary,
    getSalesReport,
    getProfitLoss,
    getCustomerLedger,
    getRecoveryReport,
    getAllOutlets,
    getFinancialReport,
    getInstallmentRecoveriesReport,
    getOfficerRecoveryReport
};
