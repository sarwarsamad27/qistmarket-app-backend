const prisma = require('../../lib/prisma');

// Helper for current timestamp
const now = () => new Date();

/**
 * Centrally updates the physical Cash Register (Daybook) for an outlet.
 * Maintains the exact cash inflows/outflows for a given day.
 * 
 * @param {object} tx - Prisma transaction context. If not provided, uses `prisma`.
 * @param {number} outletId - The ID of the outlet.
 * @param {string} field - The specific field of CashRegister being impacted.
 * @param {number} amount - The amount to log.
 * @param {string} operation - 'add' or 'subtract'.
 */
const updateCashRegister = async (tx, outletId, field, amount, operation) => {
    const db = tx || prisma;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const val = parseFloat(amount);
    const validFields = ['down_payments', 'installments_received', 'cash_from_recovery', 'cash_from_delivery', 'expenses', 'vendor_payments'];
    
    if (!validFields.includes(field)) {
        throw new Error(`Invalid CashRegister field: ${field}`);
    }

    // Determine impact on closing_cash.
    const inflows = ['down_payments', 'installments_received', 'cash_from_recovery', 'cash_from_delivery'];
    const outflows = ['expenses', 'vendor_payments'];

    // We use a find-create logic to ensure the row exists.
    let register = await db.cashRegister.findUnique({
        where: { outlet_id_date: { outlet_id: outletId, date: today } }
    });

    if (!register) {
        // Find latest register before today to get opening balance
        const lastRegister = await db.cashRegister.findFirst({
            where: { outlet_id: outletId, date: { lt: today } },
            orderBy: { date: 'desc' }
        });
        
        const opening = lastRegister ? lastRegister.closing_cash : 0;
        register = await db.cashRegister.create({
            data: {
                outlet_id: outletId,
                date: today,
                opening_cash: opening,
                closing_cash: opening,
                created_at: now(),   // ✅ explicit created_at
                updated_at: now()    // ✅ explicit updated_at
            }
        });
    }

    // Now perform atomic update to reduce lock time and prevent data structure mismatch
    let fieldUpdate = { increment: 0 };
    let closingUpdate = { increment: 0 };

    if (operation === 'add') {
        fieldUpdate = { increment: val };
        if (inflows.includes(field)) {
            closingUpdate = { increment: val };
        } else {
            closingUpdate = { decrement: val };
        }
    } else if (operation === 'subtract') {
        fieldUpdate = { decrement: val };
        if (inflows.includes(field)) {
            closingUpdate = { decrement: val };
        } else {
            closingUpdate = { increment: val };
        }
    }

    return await db.cashRegister.update({
        where: { id: register.id },
        data: {
            [field]: fieldUpdate,
            closing_cash: closingUpdate,
            updated_at: now()   // ✅ explicit updated_at
        }
    });
};

module.exports = {
    updateCashRegister
};