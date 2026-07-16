const prisma = require('../../lib/prisma');
const { logAction } = require('../utils/auditLogger');
const { updateCashRegister } = require('../utils/cashRegisterUtils');

const generateVoucherNumber = async () => {
    const year = new Date().getFullYear();
    const prefix = `EV-${year}-`;
    const last = await prisma.expenseVoucher.findFirst({ where: { voucher_number: { startsWith: prefix } }, orderBy: { voucher_number: 'desc' } });
    const next = last ? parseInt(last.voucher_number.split('-')[2]) + 1 : 1;
    return `${prefix}${next.toString().padStart(4, '0')}`;
};

/**
 * createHeadOfficeExpense
 * Same shape as expenseController.createExpenseVoucher but outlet_id is
 * optional (null = Head Office expense) and status defaults to "pending"
 * so it flows through the approval workflow below.
 */
const createHeadOfficeExpense = async (req, res) => {
    const { outlet_id, items, payment_method, date, notes } = req.body;
    if (!items || !items.length) return res.status(400).json({ success: false, message: 'At least one expense item is required.' });

    try {
        const voucher_number = await generateVoucherNumber();
        const total_amount = items.reduce((sum, item) => sum + parseFloat(item.amount), 0);

        const voucher = await prisma.expenseVoucher.create({
            data: {
                outlet_id: outlet_id ? parseInt(outlet_id) : null,
                voucher_number,
                total_amount,
                payment_method: payment_method || 'Cash',
                date: date ? new Date(date) : new Date(),
                notes,
                status: 'pending',
                items: { create: items.map((item) => ({ category: item.category || 'General', amount: parseFloat(item.amount), description: item.description })) },
            },
            include: { items: true },
        });

        await logAction(req, 'EXPENSE_ENTRY', `${outlet_id ? 'Outlet' : 'Head Office'} expense voucher ${voucher.voucher_number} created for PKR ${voucher.total_amount}, pending approval.`, voucher.id, 'ExpenseVoucher');

        res.status(201).json({ success: true, data: voucher });
    } catch (error) {
        console.error('createHeadOfficeExpense error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getExpenseApprovalQueue = async (req, res) => {
    try {
        const { status = 'pending' } = req.query;
        const vouchers = await prisma.expenseVoucher.findMany({
            where: { status },
            include: { items: true, outlet: { select: { name: true } }, approved_by: { select: { full_name: true } } },
            orderBy: { date: 'desc' },
        });
        res.json({ success: true, data: vouchers });
    } catch (error) {
        console.error('getExpenseApprovalQueue error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * decideExpenseApproval
 * Approving posts the expense to the outlet's CashRegister (mirrors what
 * createExpenseVoucher does immediately for outlet-entered expenses);
 * rejecting leaves the cash register untouched.
 */
const decideExpenseApproval = async (req, res) => {
    try {
        const { id } = req.params;
        const { decision } = req.body; // "approved" | "rejected"
        if (!['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ success: false, message: 'decision must be approved or rejected.' });
        }

        const voucher = await prisma.expenseVoucher.findUnique({ where: { id: parseInt(id) } });
        if (!voucher) return res.status(404).json({ success: false, message: 'Expense voucher not found.' });
        if (voucher.status !== 'pending') return res.status(400).json({ success: false, message: 'This voucher has already been decided.' });

        await prisma.$transaction(async (tx) => {
            await tx.expenseVoucher.update({ where: { id: voucher.id }, data: { status: decision, approved_by_id: req.user.id, approved_at: new Date() } });
            if (decision === 'approved' && voucher.outlet_id) {
                await updateCashRegister(tx, voucher.outlet_id, 'expenses', voucher.total_amount, 'add');
            }
        });

        await logAction(req, decision === 'approved' ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED', `Expense voucher ${voucher.voucher_number} (PKR ${voucher.total_amount}) ${decision}.`, voucher.id, 'ExpenseVoucher');

        res.json({ success: true, message: `Expense ${decision}.` });
    } catch (error) {
        console.error('decideExpenseApproval error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * uploadExpenseInvoice
 * Attaches an uploaded invoice file to an existing voucher (multer-local,
 * same /uploads pattern as hrDocumentController).
 */
const uploadExpenseInvoice = async (req, res) => {
    try {
        const { id } = req.params;
        if (!req.file) return res.status(400).json({ success: false, message: 'Invoice file is required.' });

        const voucher = await prisma.expenseVoucher.update({
            where: { id: parseInt(id) },
            data: { invoice_url: `/uploads/${req.file.filename}` },
        });

        res.json({ success: true, data: voucher });
    } catch (error) {
        console.error('uploadExpenseInvoice error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getSalaryExpenses
 * Read-only view over the HR module's PayrollSlip data, presented as a
 * salary-expense line so Accounts can see total payroll cost per month
 * without duplicating payroll data into ExpenseVoucher.
 */
const getSalaryExpenses = async (req, res) => {
    try {
        const { year = new Date().getFullYear() } = req.query;

        const slips = await prisma.payrollSlip.findMany({
            where: { year: parseInt(year) },
            include: { employee: { select: { full_name: true, department: true } } },
            orderBy: [{ month: 'desc' }],
        });

        const monthMap = {};
        for (const slip of slips) {
            const key = `${slip.year}-${String(slip.month).padStart(2, '0')}`;
            if (!monthMap[key]) monthMap[key] = { month: key, total: 0, paid: 0, pending: 0, count: 0 };
            monthMap[key].total += slip.net_payable;
            monthMap[key].count += 1;
            if (slip.status === 'paid') monthMap[key].paid += slip.net_payable;
            else monthMap[key].pending += slip.net_payable;
        }

        res.json({
            success: true,
            data: {
                months: Object.values(monthMap).sort((a, b) => (a.month < b.month ? 1 : -1)),
                slips: slips.map((s) => ({
                    id: s.id, employee_name: s.employee?.full_name, department: s.employee?.department,
                    month: s.month, year: s.year, net_payable: s.net_payable, status: s.status, paid_date: s.paid_date,
                })),
            },
        });
    } catch (error) {
        console.error('getSalaryExpenses error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    createHeadOfficeExpense,
    getExpenseApprovalQueue,
    decideExpenseApproval,
    uploadExpenseInvoice,
    getSalaryExpenses,
};
