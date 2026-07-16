const prisma = require('../../lib/prisma');
const { notifyAdmins } = require('../utils/notificationUtils');

const OVERDUE_DAYS_THRESHOLD = 7;
const LOW_STOCK_THRESHOLD = 3;

/**
 * runAutomationRules
 * Daily digest — not per-event spam. Checks two conditions and sends at
 * most one Notification per condition per day to Admins:
 *  1. Installments overdue by more than OVERDUE_DAYS_THRESHOLD days.
 *  2. Products at any outlet with fewer than LOW_STOCK_THRESHOLD units
 *     "In Stock" (same rule as accountsStockController.getInventoryHealthAlerts).
 * Guards against double-sends (e.g. a manual cron re-run) by skipping a
 * check if a same-type notification was already created today.
 */
const runAutomationRules = async (io = null) => {
    const alreadySentToday = async (type) => {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const existing = await prisma.notification.findFirst({ where: { type, createdAt: { gte: startOfDay } } });
        return !!existing;
    };

    try {
        if (!(await alreadySentToday('automation_overdue_installments'))) {
            const cutoff = new Date(Date.now() - OVERDUE_DAYS_THRESHOLD * 24 * 60 * 60 * 1000);
            const orders = await prisma.order.findMany({
                where: { status: { notIn: ['Cancelled', 'Rejected'] }, is_delivered: true },
                select: { installment_ledger: { select: { ledger_rows: true } } },
            });

            let overdueCount = 0;
            for (const order of orders) {
                const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
                for (const row of rows) {
                    if (row.status === 'paid' || !row.dueDate) continue;
                    if (new Date(row.dueDate) <= cutoff) overdueCount += 1;
                }
            }

            if (overdueCount > 0) {
                await notifyAdmins(
                    'Overdue Installments Digest',
                    `${overdueCount} installment(s) are overdue by more than ${OVERDUE_DAYS_THRESHOLD} days. Review Installment Aging for details.`,
                    'automation_overdue_installments',
                    null,
                    io,
                );
            }
        }

        if (!(await alreadySentToday('automation_low_stock'))) {
            const lowStockGroups = await prisma.outletInventory.groupBy({
                by: ['outlet_id', 'product_name'],
                where: { status: 'In Stock' },
                _count: { id: true },
                having: { id: { _count: { lt: LOW_STOCK_THRESHOLD } } },
            });

            if (lowStockGroups.length > 0) {
                await notifyAdmins(
                    'Low Stock Digest',
                    `${lowStockGroups.length} product/outlet combination(s) are below the low-stock threshold. Review Inventory & Warehouse for details.`,
                    'automation_low_stock',
                    null,
                    io,
                );
            }
        }
    } catch (err) {
        console.error('[AutomationRules] Run failed:', err);
    }
};

module.exports = { runAutomationRules };
