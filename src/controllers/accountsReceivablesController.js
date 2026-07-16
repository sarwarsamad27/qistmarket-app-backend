const prisma = require('../../lib/prisma');
const { getOutletFilter } = require('../utils/outletFilter');
const { getNormalizedLedger } = require('../utils/ledgerUtils');

/**
 * getCustomerPaymentSchedule
 * Full month-by-month installment schedule for one order — due date,
 * amount, status — reusing the shared ledger normalizer so it matches
 * exactly what every other part of the app considers "the schedule".
 */
const getCustomerPaymentSchedule = async (req, res) => {
    try {
        const { order_id } = req.params;
        const order = await prisma.order.findUnique({
            where: { id: parseInt(order_id) },
            include: { installment_ledger: true, outlet: { select: { name: true } } },
        });
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        const { advance_payment, installment_ledger, summary } = getNormalizedLedger(order.installment_ledger?.ledger_rows);

        res.json({
            success: true,
            data: {
                order: { id: order.id, order_ref: order.order_ref, customer_name: order.customer_name, whatsapp_number: order.whatsapp_number, outlet_name: order.outlet?.name },
                advance_payment,
                schedule: installment_ledger,
                summary,
            },
        });
    } catch (error) {
        console.error('getCustomerPaymentSchedule error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getReceivablesRiskAnalysis
 * Classifies every order with an outstanding balance into a risk tier
 * using the same signals recoveryController's officer-scoped dashboard
 * uses (missed installment count, recent-payment behavior), but computed
 * globally across the business rather than per logged-in officer.
 */
const getReceivablesRiskAnalysis = async (req, res) => {
    const outletFilter = getOutletFilter(req);

    try {
        const orders = await prisma.order.findMany({
            where: { ...outletFilter, status: { notIn: ['Cancelled', 'Rejected'] }, is_delivered: true },
            include: { installment_ledger: true, outlet: { select: { name: true } } },
        });

        const today = new Date();
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

        const tiers = { cleared: [], regular: [], overdue: [], defaulter: [] };

        for (const order of orders) {
            const { summary, installment_ledger } = getNormalizedLedger(order.installment_ledger?.ledger_rows);
            if (summary.grandTotalRemaining <= 0) {
                tiers.cleared.push({ order_id: order.id, order_ref: order.order_ref, customer_name: order.customer_name, outlet_name: order.outlet?.name, remaining: 0 });
                continue;
            }

            const missedCount = installment_ledger.filter((r) => r.status !== 'paid' && r.dueDate && new Date(r.dueDate) < today).length;
            const recentDue = installment_ledger.filter((r) => r.dueDate && new Date(r.dueDate) >= threeMonthsAgo && new Date(r.dueDate) < today);
            const recentPaid = recentDue.filter((r) => r.status === 'paid').length;

            const entry = {
                order_id: order.id, order_ref: order.order_ref, customer_name: order.customer_name, whatsapp_number: order.whatsapp_number,
                outlet_name: order.outlet?.name, remaining: summary.grandTotalRemaining, missedCount,
            };

            if (recentDue.length > 0 && recentPaid === 0) tiers.defaulter.push(entry);
            else if (missedCount >= 2) tiers.overdue.push(entry);
            else if (missedCount === 1) tiers.regular.push(entry);
            else tiers.regular.push(entry);
        }

        res.json({
            success: true,
            data: {
                summary: { cleared: tiers.cleared.length, regular: tiers.regular.length, overdue: tiers.overdue.length, defaulter: tiers.defaulter.length },
                tiers: { regular: tiers.regular, overdue: tiers.overdue, defaulter: tiers.defaulter },
            },
        });
    } catch (error) {
        console.error('getReceivablesRiskAnalysis error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getCustomerPaymentSchedule,
    getReceivablesRiskAnalysis,
};
