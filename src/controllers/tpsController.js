const prisma = require('../../lib/prisma');
const { parseTpsAmount, formatTpsAmount, formatTpsAmountPaid } = require('../utils/tpsAmountUtils');
const { sendInstallmentPaymentReceipt, sendNextInstallmentReminder } = require('../services/watiService');

const now = () => new Date();

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
    let { consumer_number, bank_mnemonic, reserved } = req.body;

    if (!consumer_number) {
        // 04 = Invalid data per spec
        return res.status(200).json({ response_Code: '04' });
    }

    consumer_number = String(consumer_number);
    if (!consumer_number.startsWith('101710')) {
        consumer_number = '101710' + consumer_number;
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

        let calculatedAmountDue = 0;
        let inquiryDueDate = consumer.due_date ? toYYYYMMDD(consumer.due_date) : "        ";

        const ledger = await prisma.installmentLedger.findUnique({
            where: { id: consumer.ledger_id }
        });

        if (ledger && Array.isArray(ledger.ledger_rows)) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            let firstUnpaidFound = false;

            for (const row of ledger.ledger_rows) {
                if (row.status !== 'paid') {
                    const expected = parseFloat(row.amount || row.dueAmount || 0);
                    const paid = parseFloat(row.paid_amount || 0);
                    const remaining = expected - paid;

                    if (remaining > 0) {
                        const dueDate = new Date(row.due_date || row.dueDate);
                        
                        // Add if due date is passed, or if it is the first unpaid row (current month)
                        if (!firstUnpaidFound || dueDate.getTime() <= today.getTime()) {
                            calculatedAmountDue += remaining;
                            firstUnpaidFound = true;
                        }
                    }
                }
            }

            // If the consumer's actual due date has passed, return today's date
            if (consumer.due_date) {
                const due = new Date(consumer.due_date);
                due.setHours(0, 0, 0, 0);
                if (today.getTime() > due.getTime()) {
                    inquiryDueDate = toYYYYMMDD(new Date()); // return current date
                }
            }
        } else {
            calculatedAmountDue = Number(consumer.amount_due || 0);
        }

        // 00 = Valid consumer, active, bill unpaid, payment allowed
        return res.status(200).json({
            response_Code: "00",
            consumer_detail: padCustomerName(consumer.customer_name),
            bill_status: "U",
            due_date: inquiryDueDate,
            amount_within_dueDate: formatTpsAmount(calculatedAmountDue),
            amount_after_dueDate: formatTpsAmount(calculatedAmountDue),
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
    let {
        consumer_number,
        tran_auth_id,
        transaction_amount,
        tran_date,
        tran_time,
        bank_mnemonic,
        reserved
    } = req.body;

    if (consumer_number) {
        consumer_number = String(consumer_number);
        if (!consumer_number.startsWith('101710')) {
            consumer_number = '101710' + consumer_number;
        }
    }

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
                    is_duplicate: false,
                    created_at: now()   // ✅ explicit created_at
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
        let paidDateParsed = now();
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
            where: { id: consumer.ledger_id },
            include: {
                order: {
                    include: {
                        delivery: true,
                        cash_in_hand: true,
                        verification: {
                            include: { purchaser: true }
                        }
                    }
                }
            }
        });

        if (ledger && Array.isArray(ledger.ledger_rows)) {
            let rows = [...ledger.ledger_rows];

            let remainingAmount = parsedAmountFinal;
            let paymentApplied = false;

            for (let i = 0; i < rows.length; i++) {
                if (rows[i].status !== 'paid' && remainingAmount > 0) {
                    paymentApplied = true;
                    const expected = parseFloat(rows[i].amount || rows[i].dueAmount || 0);
                    const alreadyPaid = parseFloat(rows[i].paid_amount || 0);
                    const remainingForThisRow = expected - alreadyPaid;

                    let payThisRow = remainingAmount;
                    if (remainingAmount >= remainingForThisRow && remainingForThisRow > 0) {
                        payThisRow = remainingForThisRow;
                    }

                    const newPaid = alreadyPaid + payThisRow;
                    
                    if (newPaid >= expected) {
                        rows[i].status = 'paid';
                    } else if (newPaid > 0) {
                        rows[i].status = 'partial';
                    }

                    rows[i].paid_amount = newPaid;
                    rows[i].paid_at = paidDateParsed;
                    rows[i].payment_method = `1LINK TPS - ${bank_mnemonic || 'UNKNOWN'}`;

                    // Maintain cumulative payment history for this installment row
                    if (!rows[i].payment_history) {
                        rows[i].payment_history = [];
                        // Backfill previous paid amount as first entry if this row was already partially paid
                        if (alreadyPaid > 0) {
                            rows[i].payment_history.push({
                                amount: alreadyPaid,
                                date: rows[i].paid_at || paidDateParsed,
                                method: rows[i].payment_method || '1LINK TPS'
                            });
                        }
                    }
                    rows[i].payment_history.push({
                        amount: payThisRow,
                        date: paidDateParsed,
                        method: `1LINK TPS - ${bank_mnemonic || 'UNKNOWN'}`
                    });

                    remainingAmount -= payThisRow;

                    try {
                        await prisma.orderPayment.create({
                            data: {
                                order_id: ledger.order_id,
                                paymentType: 'installment',
                                monthNumber: parseInt(rows[i].month) || null,
                                amount: payThisRow,
                                paymentMethod: `1LINK TPS - ${bank_mnemonic || ''}`,
                                is_submitted: true,
                                paidAt: paidDateParsed,        // ✅ explicit paidAt
                                created_at: now()              // ✅ explicit created_at
                            }
                        });
                    } catch (paymentLogErr) {
                        console.error('[TPS BillPayment] Failed to log OrderPayment:', paymentLogErr);
                    }
                }
            }

            if (paymentApplied) {
                // Update the complete ledger
                await prisma.installmentLedger.update({
                    where: { id: ledger.id },
                    data: { 
                        ledger_rows: rows,
                        updated_at: now()   // ✅ explicit updated_at
                    }
                });

                // Send Wati Notification
                if (ledger.order) {
                    const order = ledger.order;
                    const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
                    const customerName = order.verification?.purchaser?.name || order.customer_name;
                    
                    let productName = order.product_name;
                    const imeiSerial = order.cash_in_hand?.[0]?.imei_serial || order.delivery?.product_imei || order.imei_serial || null;
                    if (imeiSerial) {
                        try {
                            const invInfo = await prisma.outletInventory.findFirst({
                                where: { imei_serial: imeiSerial },
                                select: { product_name: true }
                            });
                            if (invInfo?.product_name) {
                                productName = invInfo.product_name;
                            }
                        } catch (err) {
                            console.error('[TPS BillPayment] Error fetching inventory product name:', err);
                        }
                    }

                    if (phone) {
                        sendInstallmentPaymentReceipt(phone, {
                            customerName,
                            amount: parsedAmountFinal,
                            productName,
                            orderRef: order.order_ref,
                            date: paidDateParsed.toLocaleDateString('en-PK')
                        }).catch(err => console.error('[TPS BillPayment] Wati Receipt Error:', err));
                    }
                }
            }

            // 8. Decide what happens to ConsumerNumber for the NEXT inquiry
            const newPendingIndex = rows.findIndex(r => r.status !== 'paid');

            if (newPendingIndex !== -1) {
                // There is ANOTHER installment waiting for the future
                const nextRow = rows[newPendingIndex];

                if (paymentApplied && ledger.order) {
                    const order = ledger.order;
                    const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
                    if (phone) {
                        let productName = order.product_name;
                        const imeiSerial = order.cash_in_hand?.[0]?.imei_serial || order.delivery?.product_imei || order.imei_serial || null;
                        if (imeiSerial) {
                            try {
                                const invInfo = await prisma.outletInventory.findFirst({
                                    where: { imei_serial: imeiSerial },
                                    select: { product_name: true }
                                });
                                if (invInfo?.product_name) {
                                    productName = invInfo.product_name;
                                }
                            } catch (err) {}
                        }

                        sendNextInstallmentReminder(phone, {
                            customerName: order.verification?.purchaser?.name || order.customer_name,
                            productName,
                            monthlyAmount: nextRow.amount || nextRow.dueAmount,
                            dueDate: new Date(nextRow.due_date || nextRow.dueDate).toLocaleDateString('en-PK'),
                            ledgerUrl: ledger.token ? `${ledger.token}` : null
                        }).catch(err => console.error('[TPS BillPayment] Wati Reminder Error:', err));
                    }
                }

                // Calculate the accurate accumulated due amount including arrears
                let accumulatedDue = 0;
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                let firstFound = false;

                for (const row of rows) {
                    if (row.status !== 'paid') {
                        const expected = parseFloat(row.amount || row.dueAmount || 0);
                        const paid = parseFloat(row.paid_amount || 0);
                        const remaining = expected - paid;

                        if (remaining > 0) {
                            const dueDate = new Date(row.due_date || row.dueDate);
                            if (!firstFound || dueDate.getTime() <= today.getTime()) {
                                accumulatedDue += remaining;
                                firstFound = true;
                            }
                        }
                    }
                }

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
                        amount_due: accumulatedDue,
                        billing_month: billingMonthStr,
                        due_date: bd,
                        // Keep track of the last payment made
                        amount_paid: parsedAmountFinal,
                        date_paid: paidDateParsed,
                        tran_auth_id: String(tran_auth_id),
                        bank_mnemonic: String(bank_mnemonic),
                        updated_at: now()   // ✅ explicit updated_at
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
                        bank_mnemonic: String(bank_mnemonic),
                        updated_at: now()   // ✅ explicit updated_at
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
                    bank_mnemonic: String(bank_mnemonic),
                    updated_at: now()   // ✅ explicit updated_at
                }
            });
        }

        // 9. Update the tps_payment_logs entry with response_code_sent 00 and status paid
        await prisma.tpsPaymentLog.update({
            where: { id: logEntry.id },
            data: { response_code_sent: "00", status: "paid" }
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
