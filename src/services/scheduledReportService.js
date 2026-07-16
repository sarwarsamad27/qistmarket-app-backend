const prisma = require('../../lib/prisma');
const { Parser } = require('json2csv');
const sendEmail = require('../utils/sendEmail');

const REPORT_TYPES = ['daybook', 'expenses', 'vendor_payables', 'recovery', 'aging'];

/**
 * getReportRows
 * Fetches flat, CSV-friendly rows for a report type. Shared by the
 * on-demand export endpoint and the scheduled-email cron job below so
 * both always produce identical data for the same report_type.
 */
const getReportRows = async (reportType) => {
    switch (reportType) {
        case 'expenses': {
            const rows = await prisma.expenseVoucher.findMany({
                include: { outlet: { select: { name: true } } },
                orderBy: { date: 'desc' },
                take: 1000,
            });
            return rows.map((r) => ({
                voucher_number: r.voucher_number, outlet: r.outlet?.name || 'Head Office',
                total_amount: r.total_amount, payment_method: r.payment_method, status: r.status, date: r.date,
            }));
        }
        case 'vendor_payables': {
            const rows = await prisma.vendorPurchase.findMany({
                where: { balance: { gt: 0 } },
                include: { outlet: { select: { name: true } }, vendor: { select: { name: true } } },
                orderBy: { due_date: 'asc' },
                take: 1000,
            });
            return rows.map((r) => ({
                invoice_number: r.invoice_number, vendor: r.vendor?.name || r.vendor_name, outlet: r.outlet?.name,
                total_amount: r.total_amount, paid_amount: r.paid_amount, balance: r.balance, due_date: r.due_date,
            }));
        }
        case 'recovery': {
            const rows = await prisma.order.findMany({
                where: { status: { notIn: ['Cancelled', 'Rejected'] } },
                include: { installment_ledger: true, outlet: { select: { name: true } } },
                take: 1000,
            });
            return rows
                .map((o) => {
                    const ledgerRows = Array.isArray(o.installment_ledger?.ledger_rows) ? o.installment_ledger.ledger_rows : [];
                    const paid = ledgerRows.filter((r) => r.status === 'paid').reduce((a, r) => a + (r.amount || 0), 0);
                    return { order_ref: o.order_ref, customer: o.customer_name, outlet: o.outlet?.name, total_amount: o.total_amount, paid, balance: o.total_amount - paid };
                })
                .filter((r) => r.balance > 0);
        }
        case 'daybook': {
            const rows = await prisma.cashRegister.findMany({
                include: { outlet: { select: { name: true } } },
                orderBy: { date: 'desc' },
                take: 1000,
            });
            return rows.map((r) => ({
                outlet: r.outlet?.name, date: r.date, opening_cash: r.opening_cash, down_payments: r.down_payments,
                installments_received: r.installments_received, expenses: r.expenses, closing_cash: r.closing_cash,
            }));
        }
        case 'aging': {
            const purchases = await prisma.vendorPurchase.findMany({
                where: { balance: { gt: 0 } },
                include: { vendor: { select: { name: true } }, outlet: { select: { name: true } } },
                take: 1000,
            });
            const today = new Date();
            return purchases.map((p) => {
                const due = p.due_date ? new Date(p.due_date) : new Date(p.purchase_date);
                const daysOverdue = Math.max(0, Math.floor((today - due) / 86400000));
                return { invoice_number: p.invoice_number, vendor: p.vendor?.name || p.vendor_name, outlet: p.outlet?.name, balance: p.balance, daysOverdue };
            });
        }
        default:
            return [];
    }
};

const rowsToCsvBuffer = (rows) => {
    if (!rows.length) return Buffer.from('No data for this period.');
    const parser = new Parser({ fields: Object.keys(rows[0]) });
    return Buffer.from(parser.parse(rows));
};

/**
 * runScheduledReports
 * Checked hourly by the cron job in index.js — sends any active
 * ScheduledReportConfig whose frequency window has elapsed since
 * last_sent_at (or has never been sent).
 */
const runScheduledReports = async () => {
    const configs = await prisma.scheduledReportConfig.findMany({ where: { is_active: true } });
    const now = new Date();

    for (const config of configs) {
        const dueMs = config.frequency === 'daily' ? 24 * 3600000 : config.frequency === 'weekly' ? 7 * 24 * 3600000 : 30 * 24 * 3600000;
        const isDue = !config.last_sent_at || now - new Date(config.last_sent_at) >= dueMs;
        if (!isDue) continue;

        try {
            const rows = await getReportRows(config.report_type);
            const csvBuffer = rowsToCsvBuffer(rows);
            const recipients = config.recipients.split(',').map((r) => r.trim()).filter(Boolean);

            await sendEmail({
                to: recipients.join(','),
                subject: `Qist Market — ${config.report_type} report (${config.frequency})`,
                html: `<p>Attached is the ${config.frequency} <strong>${config.report_type}</strong> report, generated on ${now.toLocaleString()}.</p>`,
                attachments: [{ filename: `${config.report_type}_${now.toISOString().slice(0, 10)}.csv`, content: csvBuffer }],
            });

            await prisma.scheduledReportConfig.update({ where: { id: config.id }, data: { last_sent_at: now } });
            console.log(`[ScheduledReports] Sent ${config.report_type} (${config.frequency}) to ${recipients.join(', ')}`);
        } catch (err) {
            console.error(`[ScheduledReports] Failed to send config #${config.id}:`, err.message);
        }
    }
};

module.exports = { REPORT_TYPES, getReportRows, rowsToCsvBuffer, runScheduledReports };
