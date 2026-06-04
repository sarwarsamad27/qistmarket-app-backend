const prisma = require('../../lib/prisma');
const qrcode = require('qrcode');
const jwt = require('jsonwebtoken');
const { sendInstallmentPaymentReceipt, sendNextInstallmentReminder } = require('../services/watiService');

const now = () => new Date();

const SMARTPAY_TOKEN_URL = 'https://smartpay.com.pk/services/api/v1/token';
const SMARTPAY_DQR_URL = 'https://smartpay.com.pk/services/api/v1/DQR';

const generateSmartPayQr = async (req, res) => {
    const { order_id, month_number, amount, force_regenerate } = req.body;
    const { outlet_id, role } = req.user || {};

    const isOutletUser = !!outlet_id;
    const isRecoveryOfficer = role?.toLowerCase()?.includes('recovery officer');

    if (!isOutletUser && !isRecoveryOfficer) {
        return res.status(403).json({ success: false, message: 'Not authorized. Only outlet users and recovery officers can access this.' });
    }

    if (!order_id || month_number === undefined || !amount) {
        return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }

    try {
        // 1. Check if we already generated a QR for this installment
        if (!force_regenerate) {
            const existingQr = await prisma.smartPayQr.findUnique({
                where: {
                    order_id_month_number: {
                        order_id: parseInt(order_id),
                        month_number: parseInt(month_number),
                    }
                }
            });

            if (existingQr) {
                const is_expired = existingQr.expires_at ? new Date(existingQr.expires_at) < now() : false;
                
                if (!is_expired) {
                    return res.json({
                        success: true,
                        data: {
                            qr_string: existingQr.qr_string,
                            qr_image_base64: existingQr.qr_image_base64,
                            amount: existingQr.amount,
                            expires_at: existingQr.expires_at,
                            is_expired: false
                        }
                    });
                }
                // If expired and not force regenerating, we simply proceed to generate a new one
            }
        }

        // 2. Fetch Order and Customer details
        const order = await prisma.order.findUnique({
            where: { id: parseInt(order_id) },
            include: {
                verification: { include: { purchaser: true } }
            }
        });

        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
        const name = order.verification?.purchaser?.name || order.customer_name;

        let consumerNumber = "6002" + order.id.toString().padStart(4, '0');
        try {
            // Find the delivery's installment ledger
            const delivery = await prisma.delivery.findUnique({
                where: { order_id: parseInt(order_id) },
                include: { installment_ledger: true }
            });
            if (delivery && delivery.installment_ledger) {
                const smartPayConsumer = await prisma.consumerNumber.findFirst({
                    where: {
                        ledger_id: delivery.installment_ledger.id,
                        consumer_number: { startsWith: '6002' }
                    }
                });
                if (smartPayConsumer) {
                    consumerNumber = smartPayConsumer.consumer_number;
                }
            }
        } catch (e) {
            console.error('Error fetching SmartPay consumer number from DB:', e);
        }

        // Formulate Billing Month in YYMM format (current month)
        const date = new Date();
        const yy = String(date.getFullYear()).slice(-2);
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const billingMonth = `${yy}${mm}`;

        const refInfo = `QIST-${order.id}-${month_number}-${Date.now()}`.substring(0, 30);

        // 3. Call SmartPay Token API
        const username = process.env.SMARTPAY_USERNAME || 'test';
        const password = process.env.SMARTPAY_PASSWORD || 'test';

        let tokenResponse;
        try {
            const tokenReq = await fetch(SMARTPAY_TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const textResp = await tokenReq.text();
            try {
                tokenResponse = JSON.parse(textResp);
            } catch (err) {
                console.error('SmartPay Token Error - Not JSON. Response:', textResp);
                return res.status(500).json({ success: false, message: 'Payment gateway returned invalid token response' });
            }
        } catch (e) {
            console.error('SmartPay Token Fetch Error:', e);
            return res.status(500).json({ success: false, message: 'Failed to authenticate with Payment Gateway' });
        }

        if (tokenResponse?.statusCode !== "200" || !tokenResponse?.dist?.jwtToken) {
            return res.status(500).json({ success: false, message: 'Payment Gateway Authentication Failed' });
        }

        const jwtToken = tokenResponse.dist.jwtToken;

        // 4. Call SmartPay DQR API
        const payload = {
            Consumer_Number: consumerNumber,
            Consumer_Detail: name,
            Billing_Month: billingMonth,
            Amount: parseFloat(amount).toFixed(2),
            CellNo: phone,
            EMail: "",
            ReferenceInfo: refInfo,
            reserved: ""
        };

        let dqrResponse;
        try {
            const dqrReq = await fetch(SMARTPAY_DQR_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `${jwtToken}`
                },
                body: JSON.stringify(payload)
            });
            const textResp = await dqrReq.text();
            try {
                dqrResponse = JSON.parse(textResp);
            } catch (err) {
                console.error('SmartPay DQR Error - Not JSON. Response:', textResp);
                return res.status(500).json({ success: false, message: 'Payment gateway returned invalid DQR response' });
            }
        } catch (e) {
            console.error('SmartPay DQR Fetch Error:', e);
            return res.status(500).json({ success: false, message: 'Failed to generate QR string from Gateway' });
        }

        if (dqrResponse?.statusCode !== "200" || !dqrResponse?.QrString) {
            return res.status(500).json({ success: false, message: 'Gateway refused to map the QR payload' });
        }

        const qrString = dqrResponse.QrString;

        // 5. Generate base64 image from QrString
        let qrImageBase64 = "";
        try {
            qrImageBase64 = await qrcode.toDataURL(qrString, {
                errorCorrectionLevel: 'H',
                margin: 2,
                width: 400
            });
        } catch (e) {
            console.error('QRCode conversion error:', e);
            return res.status(500).json({ success: false, message: 'Failed to render QR Code image' });
        }

        // 6. Save in database with explicit created_at (model has only created_at, no updated_at)
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
        const savedQr = await prisma.smartPayQr.upsert({
            where: {
                order_id_month_number: {
                    order_id: parseInt(order_id),
                    month_number: parseInt(month_number)
                }
            },
            update: {
                qr_string: qrString,
                qr_image_base64: qrImageBase64,
                amount: parseFloat(amount),
                expires_at: expiresAt
                // No updated_at field in SmartPayQr model
            },
            create: {
                order_id: parseInt(order_id),
                month_number: parseInt(month_number),
                qr_string: qrString,
                qr_image_base64: qrImageBase64,
                amount: parseFloat(amount),
                expires_at: expiresAt,
                created_at: now()   // ✅ explicit created_at
            }
        });

        return res.json({
            success: true,
            data: {
                qr_string: savedQr.qr_string,
                qr_image_base64: savedQr.qr_image_base64,
                amount: savedQr.amount,
                expires_at: savedQr.expires_at,
                is_expired: false
            }
        });

    } catch (error) {
        console.error('generateSmartPayQr error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error while generating QR code' });
    }
};

const checkSmartPayQr = async (req, res) => {
    const { order_id, month_number } = req.query;
    const { outlet_id, role } = req.user || {};

    // Allow outlet users and recovery officers only
    const isOutletUser = !!outlet_id;
    const isRecoveryOfficer = role?.toLowerCase()?.includes('recovery officer');

    if (!isOutletUser && !isRecoveryOfficer) {
        return res.status(403).json({ success: false, message: 'Not authorized. Only outlet users and recovery officers can access this.' });
    }

    if (!order_id || month_number === undefined) {
        return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }

    try {
        const existingQr = await prisma.smartPayQr.findUnique({
            where: {
                order_id_month_number: {
                    order_id: parseInt(order_id),
                    month_number: parseInt(month_number),
                }
            }
        });

        if (existingQr) {
            const is_expired = existingQr.expires_at ? new Date(existingQr.expires_at) < new Date() : false;

            if (is_expired) {
                return res.json({
                    success: true,
                    data: {
                        is_expired: true,
                        expires_at: existingQr.expires_at,
                        amount: existingQr.amount
                    }
                });
            }

            return res.json({
                success: true,
                data: {
                    qr_string: existingQr.qr_string,
                    qr_image_base64: existingQr.qr_image_base64,
                    amount: existingQr.amount,
                    expires_at: existingQr.expires_at,
                    is_expired: false
                }
            });
        }

        return res.json({ success: true, data: null });
    } catch (error) {
        console.error('checkSmartPayQr error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error while checking QR' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// API 1: Authentication Token Generation (SmartPay Webhook)
// ─────────────────────────────────────────────────────────────────────────────
const generateToken = async (req, res) => {
    const { username, password } = req.body;

    const validUser = process.env.SMARTPAY_WEBHOOK_USER;
    const validPass = process.env.SMARTPAY_WEBHOOK_PASS;

    if (username !== validUser || password !== validPass) {
        return res.status(401).json({
            statusCode: "401",
            statusMessage: "Unauthorized"
        });
    }

    try {
        const jwtToken = jwt.sign(
            { username, issuer: "QistMarket", audience: "SmartPay" },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        return res.status(200).json({
            statusCode: "200",
            statusMessage: "Success",
            dist: {
                jwtToken
            }
        });
    } catch (e) {
        console.error('SmartPay webhook token generation error:', e);
        return res.status(500).json({
            statusCode: "500",
            statusMessage: "Internal Server Error"
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// API 2: Instant Payment Notification (SmartPay Webhook)
// ─────────────────────────────────────────────────────────────────────────────
const notifyPayment = async (req, res) => {
    let { amount, billnumber, timestamp, transactionId } = req.body;

    // Optional auth check since middleware usually handles it, but let's be safe
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ statusCode: "401", statusMessage: "Unauthorized" });
    }

    try {
        jwt.verify(authHeader.replace('Bearer ', ''), process.env.JWT_SECRET);
    } catch (err) {
        return res.status(401).json({ statusCode: "401", statusMessage: "Invalid Token" });
    }

    try {
        const parsedAmountFinal = parseFloat(amount);
        
        let logEntry;
        try {
            logEntry = await prisma.smartPayPaymentLog.create({
                data: {
                    consumer_number: String(billnumber || ''),
                    transactionId: String(transactionId || ''),
                    amount: parsedAmountFinal,
                    timestamp: String(timestamp || ''),
                    billnumber: String(billnumber || ''),
                    status: 'received',
                    is_duplicate: false,
                    created_at: now()   // ✅ explicit created_at
                }
            });
        } catch (e) {
            console.error('Error logging SmartPay webhook request:', e);
            return res.status(500).json({ statusCode: "500", statusMessage: "Internal Server Error" });
        }

        if (!billnumber || !transactionId || !amount) {
            await prisma.smartPayPaymentLog.update({ 
                where: { id: logEntry.id }, 
                data: { status: "invalid_data" } 
                // No updated_at in SmartPayPaymentLog
            });
            return res.status(400).json({ statusCode: "400", statusMessage: "Bad Request" });
        }

        const consumer = await prisma.consumerNumber.findUnique({
            where: { consumer_number: String(billnumber) }
        });

        if (!consumer) {
            await prisma.smartPayPaymentLog.update({ 
                where: { id: logEntry.id }, 
                data: { status: "not_found" } 
            });
            return res.status(404).json({ statusCode: "404", statusMessage: "Consumer not found" });
        }

        const duplicates = await prisma.smartPayPaymentLog.findMany({
            where: {
                transactionId: String(transactionId),
                id: { not: logEntry.id }
            }
        });

        if (duplicates.length > 0) {
            await prisma.smartPayPaymentLog.update({
                where: { id: logEntry.id },
                data: { is_duplicate: true, status: "duplicate" }
            });
            return res.status(200).json({ statusCode: "200", statusMessage: "Success (Duplicate)" });
        }

        if (consumer.bill_status === 'P') {
            await prisma.smartPayPaymentLog.update({ 
                where: { id: logEntry.id }, 
                data: { status: "already_paid" } 
            });
            return res.status(200).json({ statusCode: "200", statusMessage: "Success (Already Paid)" });
        }

        let paidDateParsed = now();
        if (timestamp && timestamp.length >= 14) {
            // format: yyyyddmmhhMMss
            const year = timestamp.substring(0, 4);
            const day = timestamp.substring(4, 6);
            const month = timestamp.substring(6, 8);
            const hours = timestamp.substring(8, 10);
            const minutes = timestamp.substring(10, 12);
            const seconds = timestamp.substring(12, 14);
            const constructed = new Date(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`);
            if (!isNaN(constructed.getTime())) {
                paidDateParsed = constructed;
            }
        }

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
                    rows[i].payment_method = `SmartPay QR`;

                    // Maintain cumulative payment history for this installment row
                    if (!rows[i].payment_history) {
                        rows[i].payment_history = [];
                        // Backfill previous paid amount as first entry if this row was already partially paid
                        if (alreadyPaid > 0) {
                            rows[i].payment_history.push({
                                amount: alreadyPaid,
                                date: rows[i].paid_at || paidDateParsed,
                                method: rows[i].payment_method || 'SmartPay QR'
                            });
                        }
                    }
                    rows[i].payment_history.push({
                        amount: payThisRow,
                        date: paidDateParsed,
                        method: `SmartPay QR - TxID: ${transactionId}`
                    });

                    remainingAmount -= payThisRow;

                    try {
                        await prisma.orderPayment.create({
                            data: {
                                order_id: ledger.order_id,
                                paymentType: 'installment',
                                monthNumber: parseInt(rows[i].month) || null,
                                amount: payThisRow,
                                paymentMethod: `SmartPay QR - TxID: ${transactionId}`,
                                is_submitted: true,
                                paidAt: paidDateParsed,        // ✅ explicit paidAt
                                created_at: now()              // ✅ explicit created_at
                            }
                        });
                    } catch (err) {
                        console.error('[SmartPay Webhook] Failed to log OrderPayment:', err);
                    }
                }
            }

            if (paymentApplied) {
                await prisma.installmentLedger.update({
                    where: { id: ledger.id },
                    data: { 
                        ledger_rows: rows,
                        updated_at: now()   // ✅ explicit updated_at
                    }
                });

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
                            if (invInfo?.product_name) productName = invInfo.product_name;
                        } catch (err) {}
                    }

                    if (phone) {
                        sendInstallmentPaymentReceipt(phone, {
                            customerName,
                            amount: parsedAmountFinal,
                            productName,
                            orderRef: order.order_ref,
                            date: paidDateParsed.toLocaleDateString('en-PK')
                        }).catch(err => console.error('[SmartPay Webhook] Wati Receipt Error:', err));
                    }
                }
            }

            const newPendingIndex = rows.findIndex(r => r.status !== 'paid');

            if (newPendingIndex !== -1) {
                const nextRow = rows[newPendingIndex];
                if (paymentApplied && ledger.order) {
                    const order = ledger.order;
                    const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
                    if (phone) {
                        let productName = order.product_name;
                        sendNextInstallmentReminder(phone, {
                            customerName: order.verification?.purchaser?.name || order.customer_name,
                            productName,
                            monthlyAmount: nextRow.amount || nextRow.dueAmount,
                            dueDate: new Date(nextRow.due_date || nextRow.dueDate).toLocaleDateString('en-PK'),
                            ledgerUrl: ledger.token ? `${ledger.token}` : null
                        }).catch(err => console.error('[SmartPay Webhook] Wati Reminder Error:', err));
                    }
                }

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

                // Update ALL ConsumerNumbers for this ledger with explicit timestamps
                await prisma.consumerNumber.updateMany({
                    where: { ledger_id: consumer.ledger_id },
                    data: {
                        bill_status: 'U',
                        amount_due: accumulatedDue,
                        billing_month: billingMonthStr,
                        due_date: bd,
                        amount_paid: parsedAmountFinal,
                        date_paid: paidDateParsed,          // ✅ explicit date_paid
                        tran_auth_id: String(transactionId),
                        bank_mnemonic: 'SMARTPAY',
                        updated_at: now()                   // ✅ explicit updated_at
                    }
                });
            } else {
                await prisma.consumerNumber.updateMany({
                    where: { ledger_id: consumer.ledger_id },
                    data: {
                        bill_status: 'P',
                        amount_paid: parsedAmountFinal,
                        date_paid: paidDateParsed,          // ✅ explicit date_paid
                        tran_auth_id: String(transactionId),
                        bank_mnemonic: 'SMARTPAY',
                        updated_at: now()                   // ✅ explicit updated_at
                    }
                });
            }

        } else {
            await prisma.consumerNumber.updateMany({
                where: { ledger_id: consumer.ledger_id },
                data: {
                    bill_status: 'P',
                    amount_paid: parsedAmountFinal,
                    date_paid: paidDateParsed,          // ✅ explicit date_paid
                    tran_auth_id: String(transactionId),
                    bank_mnemonic: 'SMARTPAY',
                    updated_at: now()                   // ✅ explicit updated_at
                }
            });
        }

        await prisma.smartPayPaymentLog.update({
            where: { id: logEntry.id },
            data: { status: "processed" }
        });

        return res.status(200).json({ statusCode: "200", statusMessage: "Success" });

    } catch (error) {
        console.error('[SmartPay Webhook] Error:', error);
        return res.status(500).json({ statusCode: "500", statusMessage: "Internal Server Error" });
    }
};

module.exports = {
    generateSmartPayQr,
    checkSmartPayQr,
    generateToken,
    notifyPayment
};
