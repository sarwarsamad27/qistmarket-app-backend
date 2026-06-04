const prisma = require('../../lib/prisma');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { logAction } = require('../utils/auditLogger');

// Helper for current timestamp
const now = () => new Date();

// Helper to generate sequential Voucher Number: EV-YYYY-XXXX
const generateVoucherNumber = async () => {
    const nowDate = new Date();
    const year = nowDate.getFullYear();
    const prefix = `EV-${year}-`;

    const lastVoucher = await prisma.expenseVoucher.findFirst({
        where: {
            voucher_number: { startsWith: prefix }
        },
        orderBy: { voucher_number: 'desc' }
    });

    let nextNumber = 1;
    if (lastVoucher) {
        const lastSerial = parseInt(lastVoucher.voucher_number.split('-')[2]);
        nextNumber = lastSerial + 1;
    }

    return `${prefix}${nextNumber.toString().padStart(4, '0')}`;
};

const getExpenses = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const vouchers = await prisma.expenseVoucher.findMany({
            where: { outlet_id: parseInt(outlet_id) },
            include: { items: true },
            orderBy: { date: 'desc' }
        });
        res.json({ success: true, vouchers });
    } catch (error) {
        console.error('getExpenses error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const createExpenseVoucher = async (req, res) => {
    const { outlet_id } = req.user;
    const { items, payment_method, date, notes } = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    if (!items || !items.length) return res.status(400).json({ success: false, message: 'At least one expense item is required.' });

    try {
        const voucher_number = await generateVoucherNumber();
        const total_amount = items.reduce((sum, item) => sum + parseFloat(item.amount), 0);
        const currentDate = date ? new Date(date) : now();

        const result = await prisma.$transaction(async (tx) => {
            // 1. Create the Voucher Header with explicit timestamps
            const voucher = await tx.expenseVoucher.create({
                data: {
                    outlet_id: parseInt(outlet_id),
                    voucher_number,
                    total_amount,
                    payment_method: payment_method || "Cash",
                    date: currentDate,
                    notes,
                    created_at: now(),   // ✅ explicit created_at
                    updated_at: now(),   // ✅ explicit updated_at
                    items: {
                        create: items.map(item => ({
                            category: item.category || "General",
                            amount: parseFloat(item.amount),
                            description: item.description
                            // ExpenseItem has no timestamp fields
                        }))
                    }
                },
                include: { items: true }
            });

            // 2. Update Cash Register (assuming updateCashRegister handles its own timestamps)
            await updateCashRegister(tx, parseInt(outlet_id), 'expenses', total_amount, 'add');

            return voucher;
        });

        await logAction(
            req, 
            'EXPENSE_ENTRY', 
            `New expense voucher ${result.voucher_number} created for PKR ${result.total_amount}.`,
            result.id,
            'ExpenseVoucher'
        );

        res.status(201).json({ success: true, voucher: result });
    } catch (error) {
        console.error('createExpenseVoucher error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const deleteExpenseVoucher = async (req, res) => {
    const { id } = req.params;
    const { outlet_id } = req.user;

    try {
        const result = await prisma.$transaction(async (tx) => {
            const voucher = await tx.expenseVoucher.findUnique({ where: { id: parseInt(id) } });
            if (!voucher || voucher.outlet_id !== outlet_id) {
                throw new Error('Voucher not found');
            }

            await tx.expenseVoucher.delete({ where: { id: parseInt(id) } });

            // Reverse the expense from the cash register
            await updateCashRegister(tx, outlet_id, 'expenses', voucher.total_amount, 'subtract');

            return voucher;
        });

        await logAction(
            req, 
            'EXPENSE_DELETION', 
            `Expense voucher ${result.voucher_number} (PKR ${result.total_amount}) was deleted.`,
            result.id,
            'ExpenseVoucher'
        );

        res.json({ success: true, message: 'Voucher deleted successfully.' });
    } catch (error) {
        console.error('deleteExpenseVoucher error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getExpenseSummary = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    const nowDate = new Date();
    const startOfToday = new Date(nowDate.setHours(0,0,0,0));
    const startOfMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);

    try {
        const [todayExpenses, monthExpenses, categorySummary] = await Promise.all([
            prisma.expenseVoucher.aggregate({
                where: { outlet_id: parseInt(outlet_id), date: { gte: startOfToday } },
                _sum: { total_amount: true }
            }),
            prisma.expenseVoucher.aggregate({
                where: { outlet_id: parseInt(outlet_id), date: { gte: startOfMonth } },
                _sum: { total_amount: true }
            }),
            prisma.expenseItem.groupBy({
                by: ['category'],
                where: { voucher: { outlet_id: parseInt(outlet_id) } },
                _sum: { amount: true },
                orderBy: { _sum: { amount: 'desc' } },
                take: 5
            })
        ]);

        res.json({
            success: true,
            summary: {
                today: todayExpenses._sum.total_amount || 0,
                thisMonth: monthExpenses._sum.total_amount || 0,
                topCategories: categorySummary.map(c => ({
                    category: c.category,
                    amount: c._sum.amount
                }))
            }
        });
    } catch (error) {
        console.error('getExpenseSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getExpenses,
    createExpenseVoucher,
    deleteExpenseVoucher,
    getExpenseSummary
};