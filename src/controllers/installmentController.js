const prisma = require('../../lib/prisma');
const { logAction } = require('../utils/auditLogger');

/**
 * rescheduleInstallment
 * Mutates the matching row inside InstallmentLedger.ledger_rows (an
 * untyped JSON array — no schema change needed). The original due date is
 * preserved on the row itself, and a SecurityLog entry is written via the
 * existing logAction util so the change has a real audit trail.
 */
const rescheduleInstallment = async (req, res) => {
    const { orderId } = req.params;
    const { month_number, new_due_date, reason } = req.body;

    if (!month_number || !new_due_date) {
        return res.status(400).json({ success: false, message: 'month_number and new_due_date are required.' });
    }

    try {
        const order = await prisma.order.findUnique({
            where: { id: parseInt(orderId) },
            include: { installment_ledger: true },
        });

        if (!order || !order.installment_ledger) {
            return res.status(404).json({ success: false, message: 'Order or installment ledger not found.' });
        }

        const rows = Array.isArray(order.installment_ledger.ledger_rows) ? [...order.installment_ledger.ledger_rows] : [];
        const rowIndex = rows.findIndex((r) => Number(r.month) === Number(month_number));

        if (rowIndex === -1) {
            return res.status(404).json({ success: false, message: `Installment month ${month_number} not found on this order.` });
        }

        const row = rows[rowIndex];
        if (row.status === 'paid') {
            return res.status(400).json({ success: false, message: 'Cannot reschedule an already-paid installment.' });
        }

        const oldDueDate = row.due_date || row.dueDate || null;
        rows[rowIndex] = {
            ...row,
            due_date: new_due_date,
            dueDate: new_due_date,
            original_due_date: row.original_due_date || oldDueDate,
            reschedule_reason: reason || null,
            rescheduled_at: new Date().toISOString(),
            rescheduled_by: req.user?.full_name || req.user?.username || 'Unknown',
        };

        await prisma.installmentLedger.update({
            where: { id: order.installment_ledger.id },
            data: { ledger_rows: rows },
        });

        await logAction(
            req,
            'INSTALLMENT_RESCHEDULED',
            `Installment month ${month_number} for order ${order.order_ref} rescheduled from ${oldDueDate || 'N/A'} to ${new_due_date}.${reason ? ` Reason: ${reason}` : ''}`,
            order.id,
            'Order',
        );

        res.json({
            success: true,
            message: 'Installment rescheduled.',
            data: { order_id: order.id, month_number: Number(month_number), old_due_date: oldDueDate, new_due_date },
        });
    } catch (error) {
        console.error('rescheduleInstallment error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = { rescheduleInstallment };
