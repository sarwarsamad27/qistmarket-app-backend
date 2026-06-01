const prisma = require('../../lib/prisma');

/**
 * Normalizes ledger rows by rolling over overdue unpaid amounts to the next month.
 * @param {Array} rows - The ledger rows array.
 * @returns {Array} - The normalized ledger rows.
 */
function normalizeLedger(rows) {
    if (!Array.isArray(rows)) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const updatedRows = JSON.parse(JSON.stringify(rows)); // Deep copy

    for (let i = 0; i < updatedRows.length; i++) {
        const row = updatedRows[i];
        
        // Skip month 0 (Advance) for rollover logic
        if (row.month === 0) continue;

        const dueDate = row.due_date || row.dueDate;
        if (!dueDate) continue;

        const dDate = new Date(dueDate);
        const status = (row.status || '').toLowerCase();
        
        const dueAmount = Number(row.amount || row.dueAmount || 0);
        const paidAmount = Number(row.paid_amount || (status === 'paid' ? dueAmount : 0));
        
        // If row is overdue and not fully paid
        if (dDate < today && status !== 'paid' && paidAmount < dueAmount) {
            const remaining = dueAmount - paidAmount;

            if (remaining > 0) {
                // Find the next month row
                const nextRow = updatedRows.find(r => r.month === row.month + 1);

                if (nextRow) {
                    // Update current row to be "paid" at the amount actually paid
                    row.amount = paidAmount;
                    row.status = 'paid';
                    row.paid_amount = paidAmount;
                    
                    // Push remaining to next month
                    nextRow.amount = (Number(nextRow.amount || nextRow.dueAmount || 0)) + remaining;
                    nextRow.arrears = (Number(nextRow.arrears || 0)) + remaining;
                }
            }
        }
        
        // Ensure paid_amount and remainingAmount are present for UI/API consistency
        const currentDue = Number(row.amount || row.dueAmount || 0);
        if (row.paid_amount === undefined) {
            row.paid_amount = (status === 'paid') ? currentDue : 0;
        }
        row.paidAmount = Number(row.paid_amount);
        row.dueAmount = currentDue;
        row.remainingAmount = Math.max(0, currentDue - row.paidAmount);

        // Update status to 'partial' if partially paid
        if (row.status !== 'paid' && row.paidAmount > 0 && row.remainingAmount > 0) {
            row.status = 'partial';
        }
    }

    return updatedRows;
}

/**
 * Returns a structured object with advance, installments, and a financial summary.
 */
function getNormalizedLedger(rows) {
    const updatedRows = normalizeLedger(rows);
    
    const advanceRow = updatedRows.find(r => r.month === 0);
    const advancePayment = {
        amount: Number(advanceRow?.amount || 0),
        paid: advanceRow?.status === 'paid',
        paidAt: advanceRow?.paid_at || advanceRow?.paidAt || null,
        paymentMethod: advanceRow?.payment_method || advanceRow?.paymentMethod || null,
        status: advanceRow?.status || 'pending',
    };

    const installmentLedger = updatedRows.filter(r => r.month > 0).map(row => ({
        monthNumber: row.month,
        label: row.label || `Month ${row.month}`,
        dueDate: row.due_date || row.dueDate || null,
        dueAmount: Number(row.amount || 0),
        paidAmount: Number(row.paid_amount || 0),
        remainingAmount: Math.max(0, Number(row.amount || 0) - Number(row.paid_amount || 0)),
        status: row.status || 'pending',
        paidAt: row.paid_at || null,
        paymentMethod: row.payment_method || null,
        arrears: row.arrears || 0,
        // Preserve full partial-payment history for both naming conventions
        paymentHistory: row.payment_history || row.paymentHistory || [],
        payment_history: row.payment_history || row.paymentHistory || [],
    }));

    const totalInstallmentDue = installmentLedger.reduce((sum, r) => sum + r.dueAmount, 0);
    const totalInstallmentPaid = installmentLedger.reduce((sum, r) => sum + r.paidAmount, 0);
    const totalInstallmentRemaining = Math.max(0, totalInstallmentDue - totalInstallmentPaid);
    const totalArrears = installmentLedger.reduce((sum, r) => sum + (r.arrears || 0), 0);

    const grandTotalDue = advancePayment.amount + totalInstallmentDue;
    const grandTotalPaid = (advancePayment.paid ? advancePayment.amount : 0) + totalInstallmentPaid;
    const grandTotalRemaining = Math.max(0, grandTotalDue - grandTotalPaid);

    const summary = {
        totalInstallmentDue,
        totalInstallmentPaid,
        totalInstallmentRemaining,
        totalArrears,
        grandTotalDue,
        grandTotalPaid,
        grandTotalRemaining,
        paidInstallments: installmentLedger.filter(r => r.status === 'paid').length,
        pendingInstallments: installmentLedger.filter(r => r.status !== 'paid').length,
        installmentsStarted: updatedRows.some(r => r.month > 0),
        firstInstallmentDate: installmentLedger[0]?.dueDate || null,
    };

    return {
        advance_payment: advancePayment,
        installment_ledger: installmentLedger,
        summary,
        rows: updatedRows // Keep raw rows too
    };
}

module.exports = {
    normalizeLedger,
    getNormalizedLedger
};
