const prisma = require('../../lib/prisma');
const { parseTpsAmount, formatTpsAmount, formatTpsAmountPaid } = require('../utils/tpsAmountUtils');

// ─────────────────────────────────────────────────────────────────────────────
// TPS / 1LINK strict API Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates consumer detail to strictly 30 characters left-justified right padded.
 * SPEC: "CUSTOMER NAME padded to 30 chars left justified right padded with spaces"
 */
function padCustomerName(name) {
    let str = (name || '').trim();
    if (str.length > 30) {
        str = str.substring(0, 30);
    }
    return str.padEnd(30, ' ');
}

/**
 * Format Date to YYYYMMDD string safely.
 */
function toYYYYMMDD(dateObj) {
    if (!dateObj || isNaN(new Date(dateObj).getTime())) return '        '; // 8 spaces fallback
    const d = new Date(dateObj);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/1.0/Payments/BillInquiry
// ─────────────────────────────────────────────────────────────────────────────
const billInquiry = async (req, res) => {
    const { consumer_number, bank_mnemonic, reserved } = req.body;

    if (!consumer_number) {
        // 04 = Invalid data per spec
        return res.status(200).json({ response_Code: '04' });
    }

    try {
        // 2. Look up the consumer_number in the consumer_numbers table
        const consumer = await prisma.consumerNumber.findUnique({
            where: { consumer_number: String(consumer_number) }
        });

        if (!consumer) {
            // 01 = Consumer number does not exist in database
            return res.status(200).json({
                response_Code: "01",
                consumer_detail: padCustomerName("NOT FOUND"),
                bill_status: "U",
                due_date: "        ",
                amount_within_dueDate: formatTpsAmount(0),
                amount_after_dueDate: formatTpsAmount(0),
                billing_month: "    ",
                date_paid: "        ",
                amount_paid: "            ",
                tran_auth_id: "      ",
                reserved: reserved || ""
            });
        }

        if (consumer.bill_status === 'B') {
            // 02 = Consumer number is blocked
            return res.status(200).json({
                response_Code: "02",
                consumer_detail: padCustomerName(consumer.customer_name),
                bill_status: "B",
                due_date: "        ",
                amount_within_dueDate: formatTpsAmount(0),
                amount_after_dueDate: formatTpsAmount(0),
                billing_month: "    ",
                date_paid: "        ",
                amount_paid: "            ",
                tran_auth_id: "      ",
                reserved: reserved || ""
            });
        }

        if (consumer.bill_status === 'P') {
            // 06 = Bill already paid
            return res.status(200).json({
                response_Code: "06",
                consumer_detail: padCustomerName(consumer.customer_name),
                bill_status: "P",
                due_date: toYYYYMMDD(consumer.due_date),
                amount_within_dueDate: formatTpsAmount(consumer.amount_due),
                amount_after_dueDate: formatTpsAmount(consumer.amount_due),
                billing_month: consumer.billing_month || "    ",
                date_paid: toYYYYMMDD(consumer.date_paid),
                amount_paid: formatTpsAmountPaid(consumer.amount_paid || consumer.amount_due),
                tran_auth_id: String(consumer.tran_auth_id || '').padEnd(6, ' '),
                reserved: reserved || ""
            });
        }

        // 00 = Valid consumer, active, bill unpaid, payment allowed
        return res.status(200).json({
            response_Code: "00",
            consumer_detail: padCustomerName(consumer.customer_name),
            bill_status: "U",
            due_date: toYYYYMMDD(consumer.due_date),
            amount_within_dueDate: formatTpsAmount(consumer.amount_due),
            amount_after_dueDate: formatTpsAmount(consumer.amount_due),
            billing_month: consumer.billing_month || "    ",
            date_paid: "        ",       // exactly 8 spaces
            amount_paid: "            ",    // exactly 12 spaces
            tran_auth_id: "      ",       // exactly 6 spaces
            reserved: reserved || ""
        });

    } catch (error) {
        console.error('[TPS BillInquiry] Error:', error);
        // 05 = Service fail or Unknown error 03
        return res.status(200).json({ response_Code: "05" });
    }
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/1.0/Payments/BillPayment
// ─────────────────────────────────────────────────────────────────────────────
const billPayment = async (req, res) => {
    const {
        consumer_number,
        tran_auth_id,
        transaction_amount,
        tran_date,
        tran_time,
        bank_mnemonic,
        reserved
    } = req.body;

    // 1. Validate auth headers (Already successfully handled by tpsAuth middleware)

    try {
        // 2. Log this request immediately to tps_payment_logs table before doing anything else
        let logEntry;
        try {
            const parsedAmount = parseTpsAmount(transaction_amount);
            logEntry = await prisma.tpsPaymentLog.create({
                data: {
                    consumer_number: String(consumer_number || ''),
                    tran_auth_id: String(tran_auth_id || ''),
                    transaction_amount_raw: String(transaction_amount || ''),
                    transaction_amount_parsed: parsedAmount,
                    tran_date: String(tran_date || ''),
                    tran_time: String(tran_time || ''),
                    bank_mnemonic: String(bank_mnemonic || ''),
                    reserved: reserved || null,
                    response_code_sent: "00", // Will be updated if an error occurs
                    is_duplicate: false
                }
            });
        } catch (logErr) {
            console.error('[TPS BillPayment] CRITICAL ERROR logging to tps_payment_logs:', logErr);
            return res.status(200).json({ response_Code: "05", Identification_parameter: "ERROR" });
        }

        if (!consumer_number || !tran_auth_id || !transaction_amount) {
            // 04 = Invalid data
            await prisma.tpsPaymentLog.update({ where: { id: logEntry.id }, data: { response_code_sent: "04" } });
            return res.status(200).json({ response_Code: "04" });
        }

        // 3. Check if consumer_number exists in consumer_numbers table, if not return 01
        const consumer = await prisma.consumerNumber.findUnique({
            where: { consumer_number: String(consumer_number) }
        });

        if (!consumer) {
            await prisma.tpsPaymentLog.update({ where: { id: logEntry.id }, data: { response_code_sent: "01" } });
            return res.status(200).json({ response_Code: "01" });
        }

        // 4. Check for duplicate transaction
        // Combination: consumer_number + tran_auth_id + tran_date + tran_time
        const duplicates = await prisma.tpsPaymentLog.findMany({
            where: {
                consumer_number: String(consumer_number),
                tran_auth_id: String(tran_auth_id),
                tran_date: String(tran_date),
                tran_time: String(tran_time),
                id: { not: logEntry.id } // Exclude the log we literally just inserted
            }
        });

        if (duplicates.length > 0) {
            // Duplicate transaction found! update log to 03 and is_duplicate true
            await prisma.tpsPaymentLog.update({
                where: { id: logEntry.id },
                data: { is_duplicate: true, response_code_sent: "03" }
            });
            return res.status(200).json({ response_Code: "03" });
        }

        // 5. Check if bill_status is already P meaning already paid
        if (consumer.bill_status === 'P') {
            await prisma.tpsPaymentLog.update({ where: { id: logEntry.id }, data: { response_code_sent: "06" } });
            return res.status(200).json({ response_Code: "06" });
        }

        // 6. Parse the transaction_amount string using the parseTpsAmount utility
        const parsedAmountFinal = parseTpsAmount(transaction_amount);

        // 7. Process payment in the main system and rollover the Consumer Number
        let paidDateParsed = new Date();
        if (typeof tran_date === 'string' && tran_date.length === 8) {
            const year = tran_date.substring(0, 4);
            const month = tran_date.substring(4, 6);
            const day = tran_date.substring(6, 8);
            const constructed = new Date(`${year}-${month}-${day}T00:00:00Z`);
            if (!isNaN(constructed.getTime())) {
                paidDateParsed = constructed;
            }
        }

        // Load ledger
        const ledger = await prisma.installmentLedger.findUnique({
            where: { id: consumer.ledger_id }
        });

        if (ledger && Array.isArray(ledger.ledger_rows)) {
            let rows = [...ledger.ledger_rows];

            // Find the row they are currently paying for
            const pendingIndex = rows.findIndex(r => r.status === 'pending');

            if (pendingIndex !== -1) {
                // Mark current row as paid
                rows[pendingIndex].status = 'paid';
                rows[pendingIndex].paid_amount = parsedAmountFinal;
                rows[pendingIndex].paid_at = paidDateParsed;
                rows[pendingIndex].payment_method = `1LINK TPS - ${bank_mnemonic || 'UNKNOWN'}`;

                // Update the complete ledger
                await prisma.installmentLedger.update({
                    where: { id: ledger.id },
                    data: { ledger_rows: rows }
                });

                // Insert into OrderPayment for admin tracking
                try {
                    await prisma.orderPayment.create({
                        data: {
                            order_id: ledger.order_id,
                            paymentType: 'installment',
                            monthNumber: parseInt(rows[pendingIndex].month) || null,
                            amount: parsedAmountFinal,
                            paymentMethod: `1LINK TPS - ${bank_mnemonic || ''}`,
                            is_submitted: true,
                            paidAt: paidDateParsed
                        }
                    });
                } catch (paymentLogErr) {
                    console.error('[TPS BillPayment] Failed to log OrderPayment:', paymentLogErr);
                }
            }

            // 8. Decide what happens to ConsumerNumber for the NEXT inquiry
            const newPendingIndex = rows.findIndex(r => r.status === 'pending');

            if (newPendingIndex !== -1) {
                // There is ANOTHER installment waiting for the future
                const nextRow = rows[newPendingIndex];

                let bd = new Date();
                let billingMonthStr = "0000";
                if (nextRow.due_date || nextRow.dueDate) {
                    const d = new Date(nextRow.due_date || nextRow.dueDate);
                    if (!isNaN(d.getTime())) {
                        bd = d;
                        billingMonthStr = String(d.getFullYear()).slice(-2) + String(d.getMonth() + 1).padStart(2, '0');
                    }
                }

                await prisma.consumerNumber.update({
                    where: { id: consumer.id },
                    data: {
                        bill_status: 'U', // Cycle to Unpaid for the next month!
                        amount_due: parseFloat(nextRow.amount || nextRow.dueAmount || 0),
                        billing_month: billingMonthStr,
                        due_date: bd,

                        // Keep track of the last payment made
                        amount_paid: parsedAmountFinal,
                        date_paid: paidDateParsed,
                        tran_auth_id: String(tran_auth_id),
                        bank_mnemonic: String(bank_mnemonic)
                    }
                });
            } else {
                // Fully paid off forever! No pending rows left.
                await prisma.consumerNumber.update({
                    where: { id: consumer.id },
                    data: {
                        bill_status: 'P',
                        amount_paid: parsedAmountFinal,
                        date_paid: paidDateParsed,
                        tran_auth_id: String(tran_auth_id),
                        bank_mnemonic: String(bank_mnemonic)
                    }
                });
            }

        } else {
            // Failsafe: if ledger somehow missing, just mark it paid
            await prisma.consumerNumber.update({
                where: { id: consumer.id },
                data: {
                    bill_status: 'P',
                    amount_paid: parsedAmountFinal,
                    date_paid: paidDateParsed,
                    tran_auth_id: String(tran_auth_id),
                    bank_mnemonic: String(bank_mnemonic)
                }
            });
        }

        // 9. Update the tps_payment_logs entry with response_code_sent 00
        await prisma.tpsPaymentLog.update({
            where: { id: logEntry.id },
            data: { response_code_sent: "00" }
        });

        // 10. Return success response
        return res.status(200).json({
            response_Code: "00",
            Identification_parameter: padCustomerName(consumer.customer_name),
            reserved: reserved || ""
        });

    } catch (error) {
        console.error('[TPS BillPayment] Error:', error);
        // 05 = Processing failed / Server crash
        return res.status(200).json({ response_Code: "05" });
    }
};

module.exports = { billInquiry, billPayment };
