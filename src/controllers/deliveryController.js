const prisma = require('../../lib/prisma');
const { logOrderStatusChange } = require('../utils/orderAuditLogger');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { sendOTP, sendDeliveryConfirmation, sendInstallmentLedger } = require('../services/watiService');
const { notifyUser, notifyAdmins, notifyOutlet } = require('../utils/notificationUtils');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const admin = require('firebase-admin');
const { getPKTDate, formatPKTDate } = require("../utils/dateUtils");
const { generateConsumerNumber } = require('../utils/consumerNumberUtils');
const { createOfficerTransaction } = require('../utils/officerTransactionUtils');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

// ─── Cash Submission OTP Notification Helper ──────────────────────────────────

async function sendCashSubmissionOTPNotification(user, otp, io = null) {
  const title = 'Cash Submission OTP';
  const message = `Your Cash Submission OTP is: ${otp}`;
  const notificationType = 'cash_submission_otp';

  if (user?.id) {
    await notifyUser(user.id, title, message, notificationType, null, io);
  }

  if (!user?.fcm_token) return;

  try {
    await admin.messaging().send({
      token: user.fcm_token,
      notification: { title, body: message },
      data: {
        type: notificationType,
        otp: otp
      },
    });
  } catch (fcmError) {
    console.error('FCM send failed for cash submission OTP:', fcmError);
  }
}

const LEDGER_TOKEN_SECRET = process.env.LEDGER_TOKEN_SECRET;
const LEDGER_BASE_URL = (process.env.LEDGER_BASE_URL || 'https://qistmarket.pk').replace(/\/$/, '');

// ─── Helpers ────────────────────────────────────────────────────────────────

const formatDatePK = (d) => {
  const date = d ? new Date(d) : new Date();
  return date.toLocaleDateString('en-PK', {
    day: '2-digit', month: 'short', year: 'numeric',
    timeZone: 'Asia/Karachi'
  });
};

const addMonths = (date, n) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
};

// Submit Delivery (Batch Upload)
const submitDelivery = async (req, res) => {
  const { order_id, product_imei, selected_plan, phone, feedback } = req.body;

  if (!order_id) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'order_id is required' }
    });
  }

  try {
    // Check if order exists and is assigned to the current user
    const order = await prisma.order.findUnique({
      where: {
        id: parseInt(order_id),
        delivery_officer_id: req.user.id
      },
      include: {
        delivery: true,
        verification: { include: { purchaser: true } }
      }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found or not assigned to you' }
      });
    }

    if (order.delivery) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Delivery already submitted for this order' }
      });
    }

    // Update purchaser phone number if provided
    if (phone && order.verification?.purchaser) {
      await prisma.purchaserVerification.update({
        where: { id: order.verification.purchaser.id },
        data: { telephone_number: phone }
      });
      order.verification.purchaser.telephone_number = phone;
    }

    // Process files and tags
    const facePhotos = req.files['face_photos'] || [];
    const locationPhotos = req.files['location_photos'] || [];
    const housePhotos = req.files['house_photos'] || [];

    const faceTags = req.body.face_tags ? JSON.parse(req.body.face_tags) : [];
    const locationTags = req.body.location_tags ? JSON.parse(req.body.location_tags) : [];
    const houseTags = req.body.house_tags ? JSON.parse(req.body.house_tags) : [];
    const locationLinks = req.body.location_links ? JSON.parse(req.body.location_links) : [];
    const linkTags = req.body.link_tags ? JSON.parse(req.body.link_tags) : [];

    // Validate counts
    if (facePhotos.length > 5 || locationPhotos.length > 5 || housePhotos.length > 5 || locationLinks.length > 5) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Maximum 5 items per type allowed' }
      });
    }

    // Create delivery
    const delivery = await prisma.delivery.create({
      data: {
        order_id: parseInt(order_id),
        delivery_agent_id: req.user.id,
        status: 'completed',
        start_time: getPKTDate(new Date()),
        end_time: getPKTDate(new Date()),
        verified: true,
        product_imei: product_imei || null,
        selected_plan: selected_plan || null,
        feedback: feedback || null
      }
    });

    // Snapshot variables for Cash In Hand
    let colorVariant = null;
    let productNameSnapshot = null;
    let stockTransferId = null;

    // Update Inventory Status and Transfer History if IMEI provided
    if (product_imei) {
      const inventory = await prisma.outletInventory.findFirst({
        where: { imei_serial: product_imei }
      });

      if (inventory) {
        // Mark inventory as Sold since it has been successfully delivered
        await prisma.outletInventory.update({
          where: { id: inventory.id },
          data: { status: 'Sold' }
        });

        colorVariant = inventory.color_variant || null;
        productNameSnapshot = inventory.product_name;

        // Mark transfer as delivered
        const transfer = await prisma.stockTransfer.findFirst({
          where: {
            inventory_id: inventory.id,
            to_id: req.user.id,
            to_type: 'Delivery Officer',
            status: 'pending'
          }
        });

        if (transfer) {
          stockTransferId = transfer.id;
          await prisma.stockTransfer.update({
            where: { id: transfer.id },
            data: { status: 'delivered' }
          });
        }
      }
    }

    // Create uploads
    const uploadsData = [];

    // Face photos
    facePhotos.forEach((file, index) => {
      uploadsData.push({
        delivery_id: delivery.id,
        upload_type: 'face_photo',
        file_url: file.url,
        tag: faceTags[index] || null,
        uploaded_at: getPKTDate(new Date())
      });
    });

    // Location photos
    locationPhotos.forEach((file, index) => {
      uploadsData.push({
        delivery_id: delivery.id,
        upload_type: 'location_photo',
        file_url: file.url,
        tag: locationTags[index] || null,
        uploaded_at: getPKTDate(new Date())
      });
    });

    // House photos
    housePhotos.forEach((file, index) => {
      uploadsData.push({
        delivery_id: delivery.id,
        upload_type: 'house_photo',
        file_url: file.url,
        tag: houseTags[index] || null,
        uploaded_at: getPKTDate(new Date())
      });
    });

    // Location links
    locationLinks.forEach((link, index) => {
      uploadsData.push({
        delivery_id: delivery.id,
        upload_type: 'location_link',
        link: link,
        tag: linkTags[index] || null,
        uploaded_at: getPKTDate(new Date())
      });
    });

    if (uploadsData.length > 0) {
      await prisma.deliveryUpload.createMany({
        data: uploadsData
      });
    }

    // Update order status
    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: {
        status: 'delivered',
        is_delivered: true
      }
    });

    await logOrderStatusChange(parseInt(order_id), order.status, 'delivered', req.user);

    // Determine advance amount STRICTLY from delivery context (selected_plan)
    let advanceAmount = 0.0;
    let planObj = null;

    if (selected_plan) {
      try {
        planObj = typeof selected_plan === 'string' ? JSON.parse(selected_plan) : selected_plan;
        if (planObj && (planObj.advance !== undefined || planObj.advance_amount !== undefined)) {
          advanceAmount = parseFloat(planObj.advance || planObj.advance_amount);
        }
      } catch (e) {
        console.error('Error parsing selected_plan:', e);
      }
    }

    // Get confirmed purchaser name from verification if available
    const purchaser = order.verification?.purchaser;
    const confirmedCustomerName = purchaser?.name || purchaser?.full_name || order.customer_name;

    // Create Cash In Hand entry for advance amount using delivery snapshots
    if (advanceAmount > 0) {
      await prisma.cashInHand.create({
        data: {
          officer_id: req.user.id,
          order_id: parseInt(order_id),
          amount: advanceAmount,
          status: 'pending',
          customer_name: confirmedCustomerName,
          product_name: productNameSnapshot,
          imei_serial: product_imei || null,
          color_variant: colorVariant || null,
          stock_transfer_id: stockTransferId,
          payment_method: 'Cash',
          created_at: getPKTDate(new Date())
        }
      });

      // Create Officer Transaction for this credit
      await createOfficerTransaction({
        officer_id: req.user.id,
        type: 'credit',
        amount: advanceAmount,
        status: 'pending',
        description: `Advance payment collected from ${confirmedCustomerName}`,
        payment_method: 'Cash',
        order_ref: order.order_ref
      });
    }

    // ─── Build Installment Ledger ────────────────────────────────────────────
    let installmentLedger = null;
    let ledgerUrl = null;
    try {
      // Parse plan for installment data
      const monthlyAmt = planObj?.monthly_amount || planObj?.monthlyAmount || order.monthly_amount || 0;
      const totalMonths = planObj?.months || planObj?.duration || order.months || 0;
      const deliveryDate = new Date();

      if (totalMonths > 0 && monthlyAmt > 0) {
        let ledgerRows = [];

        // Use custom ledger from frontend if provided (user edited dates/amounts)
        let customLedger = null;
        try {
          const raw = req.body.custom_ledger;
          if (raw) customLedger = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) { /* ignore parse errors */ }

        // 1. Advance Payment row (always month 0, always auto)
        ledgerRows.push({
          month: 0,
          label: 'Advance Payment',
          due_date: deliveryDate.toISOString(),
          amount: parseFloat(advanceAmount || 0),
          status: 'paid',
          paid_at: deliveryDate.toISOString(),
          payment_method: 'Cash',
          feedback: 'Collected at Delivery'
        });

        if (customLedger && Array.isArray(customLedger) && customLedger.length === totalMonths) {
          // 2a. Use edited installment rows from the UI
          customLedger.forEach((row, i) => {
            ledgerRows.push({
              month: i + 1,
              label: `Month ${i + 1}`,
              due_date: row.date ? new Date(row.date).toISOString() : addMonths(deliveryDate, i + 1).toISOString(),
              amount: parseFloat(row.amount) || parseFloat(monthlyAmt),
              status: 'pending',
              paid_at: null,
            });
          });
        } else {
          // 2b. Auto-generate installment rows
          for (let i = 0; i < totalMonths; i++) {
            ledgerRows.push({
              month: i + 1,
              label: `Month ${i + 1}`,
              due_date: addMonths(deliveryDate, i + 1).toISOString(),
              amount: parseFloat(monthlyAmt),
              status: 'pending',
              paid_at: null,
            });
          }
        }

        // Sign a long-lived token (2 years) — kept for backward compat
        const ledgerToken = jwt.sign(
          { order_id: parseInt(order_id), delivery_id: delivery.id },
          LEDGER_TOKEN_SECRET,
          { expiresIn: '730d' }
        );

        // Short unique ID for the PDF download link
        const shortId = crypto.randomBytes(5).toString('hex');
        ledgerUrl = `${ledgerToken}`;

        // Upsert ledger (safe if re-run)
        installmentLedger = await prisma.installmentLedger.upsert({
          where: { order_id: parseInt(order_id) },
          create: {
            order_id: parseInt(order_id),
            delivery_id: delivery.id,
            token: ledgerToken,
            short_id: shortId,
            ledger_rows: ledgerRows,
          },
          update: {
            token: ledgerToken,
            short_id: shortId,
            ledger_rows: ledgerRows,
          },
        });

        const mobile = purchaser?.telephone_number || order.whatsapp_number;
        const consumerNo = await generateConsumerNumber(product_imei, mobile);

        // Save the consumer_numbers record 
        // using the new table as specified by 1Bill TPS spec
        let firstMonthDue = 0;
        let dueDate = getPKTDate();
        let billingMonthStr = "0000";

        if (Array.isArray(ledgerRows) && ledgerRows.length > 1) {
          // Row 1 is Month 1 since Row 0 is Advance Payment
          firstMonthDue = ledgerRows[1].amount || 0;
          if (ledgerRows[1].due_date) {
            const d = new Date(ledgerRows[1].due_date);
            if (!isNaN(d.getTime())) {
              dueDate = d;
              billingMonthStr = String(d.getFullYear()).slice(-2) + String(d.getMonth() + 1).padStart(2, '0');
            }
          }
        }

        try {
          await prisma.consumerNumber.create({
            data: {
              consumer_number: consumerNo,
              ledger_id: installmentLedger.id,
              delivery_id: delivery.id,
              customer_name: purchaser?.name || order.customer_name || 'N/A',
              mobile_number: mobile || 'N/A',
              imei_serial: product_imei || null,
              amount_due: firstMonthDue,
              billing_month: billingMonthStr,
              due_date: dueDate,
              bill_status: 'U', // Unpaid
            }
          });
        } catch (consumerErr) {
          console.error('[submitDelivery] Failed to create ConsumerNumber (Non-fatal):', consumerErr);
        }

      }
    } catch (ledgerErr) {
      // Non-fatal — log and continue
      console.error('[submitDelivery] Ledger creation error:', ledgerErr);
    }


    // ─── WATI Messages ───────────────────────────────────────────────────────
    const customerPhone = purchaser?.telephone_number;
    const deliveryDateStr = formatDatePK(new Date());
    const colorVariantStr = colorVariant || 'N/A';

    if (customerPhone) {
      // Template 1: Delivery Confirmation
      sendDeliveryConfirmation(customerPhone, {
        customerName: confirmedCustomerName,
        productName: productNameSnapshot,
        imei: product_imei || 'N/A',
        colorVariant: colorVariantStr,
        advanceAmount,
        deliveryDate: deliveryDateStr,
        orderRef: order.order_ref,
        orderStatus: 'Delivered',
      }).then(r => console.log('[WATI] Delivery confirmation:', r.success ? 'sent ✓' : r.error))
        .catch(e => console.error('[WATI] Delivery confirmation error:', e));

      // Template 2: Installment Ledger (only if ledger was created)
      if (installmentLedger && ledgerUrl) {
        const rows = Array.isArray(installmentLedger.ledger_rows) ? installmentLedger.ledger_rows : [];
        const firstRow = rows[1];
        const totalRemain = rows.reduce((s, r) => s + (r.amount || 0), 0);

        sendInstallmentLedger(customerPhone, {
          customerName: confirmedCustomerName,
          productName: productNameSnapshot,
          orderRef: order.order_ref,
          nextMonthLabel: 'Mahina 1',
          monthlyAmount: firstRow?.amount || 0,
          dueDate: firstRow ? formatDatePK(firstRow.due_date) : 'N/A',
          totalRemaining: totalRemain,
          ledgerUrl,
        }).then(r => console.log('[WATI] Ledger template:', r.success ? 'sent ✓' : r.error))
          .catch(e => console.error('[WATI] Ledger template error:', e));
      }
    } else {
      console.warn('[submitDelivery] No customer phone — WATI messages skipped for order', order.order_ref);
    }

    // Fetch updated delivery
    const updatedDelivery = await prisma.delivery.findUnique({
      where: { id: delivery.id },
      include: {
        delivery_agent: {
          select: { full_name: true, username: true }
        },
        uploads: true,
        order: { select: { order_ref: true } }
      }
    });

    const io = req.app.get('io');
    await notifyAdmins(
      'Delivery Submitted',
      `Delivery completed for Order #${updatedDelivery.order.order_ref} by ${updatedDelivery.delivery_agent.full_name}`,
      'delivery_complete',
      updatedDelivery.id,
      io
    );

    if (order.outlet_id) {
      await notifyOutlet(
        order.outlet_id,
        'Delivery Completed',
        `Delivery has been successfully completed for Order #${updatedDelivery.order.order_ref}.`,
        'delivery_complete',
        updatedDelivery.id,
        io
      );
    }

    return res.status(201).json({
      success: true,
      message: 'Delivery submitted successfully',
      data: { delivery: updatedDelivery, ledger_url: ledgerUrl }
    });
  } catch (error) {
    console.error('Submit delivery error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Get Delivery by Order ID
const getDeliveryByOrderId = async (req, res) => {
  const { order_id } = req.params;

  try {
    const delivery = await prisma.delivery.findUnique({
      where: { order_id: parseInt(order_id) },
      include: {
        delivery_agent: {
          select: { full_name: true, username: true }
        },
        uploads: true
      }
    });

    if (!delivery) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Delivery not found for this order' }
      });
    }

    return res.status(200).json({
      success: true,
      data: { delivery }
    });
  } catch (error) {
    console.error('Get delivery by order error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

const getPendingDeliveryProducts = async (req, res) => {
  try {
    const deliveryBoyId = req.user.id;

    if (!deliveryBoyId) {
      return res.status(401).json({
        success: false,
        error: { code: 401, message: 'Authentication required' }
      });
    }

    const orders = await prisma.order.findMany({
      where: {
        delivery_officer_id: deliveryBoyId,
        is_delivered: false,
      },
      select: {
        product_name: true,
        total_amount: true,
        advance_amount: true,
        monthly_amount: true,
        months: true,
      },
      orderBy: {
        updated_at: 'desc',
      },
    });

    if (orders.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No pending delivery orders assigned',
        data: [],
      });
    }

    const grouped = {};

    orders.forEach((order) => {
      const productKey = (order.product_name || 'N/A').trim().toLowerCase();

      if (!grouped[productKey]) {
        grouped[productKey] = {
          product_name: order.product_name.trim() || 'N/A',
          count: 0,
          total_amount: 0,
          advance_amount: 0,
          monthly_amount: 0,
          months: 0,
          sample_months: order.months ?? 0,
        };
      }

      const group = grouped[productKey];
      group.count += 1;
      group.total_amount += order.total_amount;
      group.advance_amount += order.advance_amount ?? 0;
      group.monthly_amount += order.monthly_amount ?? 0;

      if (group.months === 0 && order.months > 0) {
        group.months = order.months;
      }
    });

    const result = Object.values(grouped).map((group) => ({
      product_name: group.product_name,
      count: group.count,
      total_amount: Math.round(group.total_amount * 100) / 100,
      advance_amount: Math.round(group.advance_amount * 100) / 100,
      monthly_amount: Math.round(group.monthly_amount * 100) / 100,
      months: group.months || group.sample_months,
    }));

    result.sort((a, b) => b.count - a.count || a.product_name.localeCompare(b.product_name));

    return res.status(200).json({
      success: true,
      products: result,
    });
  } catch (error) {
    console.error('Error fetching grouped pending products:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getCashInHand = async (req, res) => {
  const { date_from, date_to, status, date } = req.query;
  const deliveryBoyId = req.user?.id;

  try {
    let where = {
      officer_id: deliveryBoyId,
    };

    // SPECIAL CASE: Agar sirf pending dekhna hai
    if (status === 'pending') {
      where.status = 'pending';
    }
    // SPECIAL CASE: Jab koi bhi filter apply nahi hai
    else if (!date && !date_from && !date_to && !status) {
      // Sab kuch dikhao - koi date filter nahi
    }
    // Normal case: Filters apply hain
    else {
      if (status) {
        where.status = status;
      }

      if (date) {
        const selectedDate = new Date(date);
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);
        where.created_at = {
          gte: selectedDate,
          lt: nextDay
        };
      } else if (date_from || date_to) {
        where.created_at = {};
        if (date_from) where.created_at.gte = new Date(date_from);
        if (date_to) where.created_at.lte = new Date(date_to);
      } else {
        const today = getPKTDate(new Date());
        today.setHours(0, 0, 0, 0);
        where.created_at = { gte: today };
      }
    }

    const cashEntries = await prisma.cashInHand.findMany({
      where,
      include: {
        order: {
          select: {
            id: true,
            order_ref: true,
            product_name: true,
            imei_serial: true,
            advance_amount: true,
            created_at: true,
            customer_name: true,
          }
        },
        outlet: {
          select: { name: true, code: true }
        },
        submission_history: {
          where: { status: 'paid' },
          orderBy: { submission_date: 'desc' }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    // === TRANSACTION HISTORY (From unified OfficerTransaction table) ===
    let txWhere = { officer_id: deliveryBoyId };
    if (status) txWhere.status = status;
    if (where.created_at) txWhere.transaction_date = where.created_at;

    const rawTransactions = await prisma.officerTransaction.findMany({
      where: txWhere,
      orderBy: { transaction_date: 'desc' }
    });

    // We can group debits by submission_ref for display, similar to the old behavior
    const groupedHistory = [];
    const debitsByRef = {};

    rawTransactions.forEach(item => {
      if (item.type === 'credit') {
        groupedHistory.push(item);
      } else {
        const ref = item.submission_ref || `individual_${item.id}`;
        if (!debitsByRef[ref]) {
          debitsByRef[ref] = {
            ...item,
            amount: 0,
            order_refs: new Set()
          };
          groupedHistory.push(debitsByRef[ref]);
        }
        debitsByRef[ref].amount += item.amount;
        if (item.order_ref && item.order_ref !== 'N/A') {
          debitsByRef[ref].order_refs.add(item.order_ref);
        }
      }
    });

    groupedHistory.forEach(item => {
      if (item.type === 'debit' && item.order_refs) {
        const refsArray = Array.from(item.order_refs);
        if (refsArray.length > 1) {
          item.description = `Combined submission for ${refsArray.length} orders`;
          item.order_ref = refsArray.join(', ');
        } else if (refsArray.length === 1) {
          item.order_ref = refsArray[0];
        }
        delete item.order_refs;
      }
    });

    // Re-sort just in case grouping affected order
    groupedHistory.sort((a, b) => new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime());

    // Calculate totals and running balance correctly
    const totalCredits = cashEntries.reduce((sum, e) => sum + e.amount, 0);
    const totalDebits = cashEntries.reduce((sum, e) => sum + (e.submitted_amount || 0), 0);
    const currentBalance = totalCredits - totalDebits;

    const totalUnpaid = cashEntries
      .filter(e => e.status === 'pending')
      .reduce((sum, e) => sum + (e.amount - (e.submitted_amount || 0)), 0);

    return res.status(200).json({
      success: true,
      transaction_history: groupedHistory,
      current_balance: currentBalance,
      total_credits: totalCredits,
      total_debits: totalDebits,
      total_unpaid: totalUnpaid
    });
  } catch (error) {
    console.error('getCashInHand error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const submitCashToOutlet = async (req, res) => {
  const { cash_in_hand_ids, cash_in_hand_id, outlet_id, payment_method, submit_amount } = req.body;
  const deliveryBoyId = req.user?.id;

  let ids = [];
  if (cash_in_hand_ids && Array.isArray(cash_in_hand_ids)) {
    ids = cash_in_hand_ids.map(id => parseInt(id));
  } else if (cash_in_hand_id) {
    ids = [parseInt(cash_in_hand_id)];
  }

  if (!outlet_id) {
    return res.status(400).json({ success: false, message: 'outlet_id is required' });
  }

  try {
    // 1. Fetch available pending entries
    let queryArgs = {
      officer_id: deliveryBoyId,
      status: 'pending'
    };

    if (ids.length > 0) {
      // Filter out any NaN or invalid IDs
      const validIds = ids.filter(id => !isNaN(id) && id > 0);
      if (validIds.length > 0) {
        queryArgs.id = { in: validIds };
      }
    }

    const availableEntries = await prisma.cashInHand.findMany({
      where: queryArgs,
      orderBy: { created_at: 'desc' }, // Latest first for LIFO
      include: {
        officer: { select: { id: true, full_name: true, phone: true, fcm_token: true } },
        order: { select: { product_name: true, order_ref: true } }
      }
    });

    if (availableEntries.length === 0) {
      return res.status(404).json({ success: false, message: 'No pending cash entries found to submit' });
    }

    // Calculate maximum available to submit
    let totalPendingAvailable = 0;
    availableEntries.forEach(e => {
      totalPendingAvailable += (e.amount - (e.submitted_amount || 0));
    });

    let amountToSubmit = parseFloat(submit_amount);
    if (isNaN(amountToSubmit) || amountToSubmit <= 0) {
      amountToSubmit = totalPendingAvailable; // Default to full submission
    }

    if (amountToSubmit > totalPendingAvailable) {
      return res.status(400).json({
        success: false,
        message: `Cannot submit more than available pending cash (PKR ${totalPendingAvailable})`
      });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const submissionRef = `SUB-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // 2. Distribute the `amountToSubmit` across `availableEntries` (FIFO logic)
    let remainingToSubmit = amountToSubmit;
    const historyCreations = [];

    for (const entry of availableEntries) {
      if (remainingToSubmit <= 0) break;

      const availableInEntry = entry.amount - (entry.submitted_amount || 0);
      const drawAmount = Math.min(availableInEntry, remainingToSubmit);

      historyCreations.push({
        cash_in_hand_id: entry.id,
        amount_submitted: drawAmount,
        status: 'pending',
        otp: otp,
        submission_ref: submissionRef, // Group them
        outlet_id: parseInt(outlet_id)
      });

      remainingToSubmit -= drawAmount;
    }

    // 3. Create the CashSubmissionHistory records
    await prisma.cashSubmissionHistory.createMany({
      data: historyCreations
    });

    // 3.1 Create OfficerTransaction records for debits sequentially to maintain correct balance
    for (const hc of historyCreations) {
      await createOfficerTransaction({
        officer_id: deliveryBoyId,
        type: 'debit',
        amount: hc.amount_submitted,
        status: 'paid',
        description: `Cash submitted to outlet`,
        payment_method: payment_method || 'Cash',
        submission_ref: hc.submission_ref
      });
    }

    const officer = availableEntries[0]?.officer;
    const officerName = officer?.full_name || 'Officer';
    const officerPhone = officer?.phone;

    // 4. Persistence & Notifications
    const otpMessage = `Your Cash Submission OTP is: ${otp}`;

    // Save to OtpLog
    const otpLog = await prisma.otpLog.create({
      data: {
        user_id: deliveryBoyId,
        action: "cash_submission_otp",
        message: otpMessage,
        otp
      }
    });

    const io = req.app.get('io');
    if (io) {
      // Real-time: Emit to Officer's room (App pickup)
      const officerRoom = `user_${deliveryBoyId}`;
      io.to(officerRoom).emit('cash_submission_otp', {
        otp_log_id: otpLog.id,
        action: otpLog.action,
        message: otpMessage,
        otp,
        created_at: otpLog.created_at
      });

      // Real-time: Notify Outlet
      io.to(`outlet_${outlet_id}`).emit('cash_submission_otp', {
        target_outlet_id: parseInt(outlet_id),
        officer_name: officerName,
        amount: amountToSubmit,
        payment_method: payment_method || 'Cash',
        otp: otp
      });

      // Save notification to DB for Outlet Users
      await notifyOutlet(
        outlet_id,
        'Cash Submission Requested',
        `${officerName} has requested to submit PKR ${amountToSubmit} to your outlet.`,
        'cash_submission_otp',
        null,
        io
      );
    }

    // Send through helper (App Push + Internal)
    await sendCashSubmissionOTPNotification(officer, otp, io);

    // Legacy: Send through WATI (WhatsApp)
    if (officerPhone) {
      sendOTP(officerPhone, otp).catch(err => console.error('WATI OTP Error:', err));
    }

    return res.status(200).json({
      success: true,
      message: 'Cash submission initiated. OTP has been sent to your App & WhatsApp.',
      total_amount: amountToSubmit
    });
  } catch (error) {
    console.error('submitCashToOutlet error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};


const generateDeliveryOtp = async (req, res) => {
  const { order_id, phone } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: {
          include: {
            purchaser: true
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ success: false, error: { message: 'Order not found' } });
    }

    if (!order.verification || !order.verification.purchaser) {
      return res.status(404).json({ success: false, error: { message: 'Verification or purchaser details not found' } });
    }

    if (order.delivery_officer_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { message: 'Order not assigned to you' } });
    }

    // Use provided phone if available, otherwise use purchaser phone
    const purchaserNumber = phone || order.verification.purchaser.telephone_number;

    if (!purchaserNumber) {
      return res.status(400).json({ success: false, error: { message: 'No phone number available' } });
    }

    const otp = await saveOTP(purchaserNumber, 'delivery');
    await sendOTP(purchaserNumber, otp);

    const io = req.app.get('io');
    await notifyAdmins(
      'Delivery OTP Generated',
      `OTP sent to purchaser for Order #${order_id}`,
      'delivery_otp_generated',
      order_id,
      io
    );

    return res.status(200).json({ success: true, message: 'OTP sent to customer' });
  } catch (error) {
    console.error('generateDeliveryOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const verifyDeliveryOtp = async (req, res) => {
  const { order_id, phone, otp, custom_ledger } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: {
          include: {
            purchaser: true
          }
        }
      }
    });

    if (!order) return res.status(404).json({ success: false, error: { message: 'Order not found' } });

    if (!order.verification || !order.verification.purchaser) {
      return res.status(404).json({ success: false, error: { message: 'Verification or purchaser details not found' } });
    }

    const purchaserNumber = phone || order.verification.purchaser.telephone_number;

    if (!purchaserNumber) {
      return res.status(400).json({ success: false, error: { message: 'No phone number available' } });
    }

    const verification = await verifyOTP(purchaserNumber, otp, 'delivery');
    if (!verification.valid) {
      return res.status(400).json({ success: true, valid: false, message: verification.message });
    }

    const io = req.app.get('io');

    // If custom_ledger is provided, it means we are also submitting the delivery (Admin Manual Flow)
    if (custom_ledger) {
      try {
        const parsedLedger = typeof custom_ledger === 'string' ? JSON.parse(custom_ledger) : custom_ledger;

        await prisma.$transaction(async (tx) => {
          // 1. Update Order Status
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: 'delivered',
              is_delivered: true,
              delivered_at: getPKTDate(new Date())
            }
          });

          // 2. Create Ledger
          await tx.installmentLedger.upsert({
            where: { order_id: order.id },
            update: {
              ledger_rows: parsedLedger,
              updated_at: getPKTDate(new Date())
            },
            create: {
              order_id: order.id,
              ledger_rows: parsedLedger,
              created_at: getPKTDate(new Date())
            }
          });

          // 3. Mark delivery as completed if exists
          const existingDelivery = await tx.delivery.findUnique({
            where: { order_id: order.id }
          });

          if (existingDelivery) {
            await tx.delivery.update({
              where: { id: existingDelivery.id },
              data: {
                status: 'completed',
                end_time: getPKTDate(new Date()),
                verified: true
              }
            });
          } else {
            // Create a basic delivery record if none exists (manual admin delivery)
            await tx.delivery.create({
              data: {
                order_id: order.id,
                delivery_agent_id: req.user.id,
                status: 'completed',
                start_time: getPKTDate(new Date()),
                end_time: getPKTDate(new Date()),
                verified: true,
                self_pickup: false
              }
            });
          }
        });

        await notifyAdmins(
          'Delivery Completed (Manual)',
          `Order #${order.order_ref} marked as delivered by ${req.user.full_name}`,
          'delivery_complete',
          order.id,
          io
        );

        return res.status(200).json({
          success: true,
          valid: true,
          message: 'OTP verified and delivery completed successfully'
        });

      } catch (e) {
        console.error('[verifyDeliveryOtp] Finalization error:', e);
        return res.status(500).json({ success: false, error: { message: 'Failed to finalize delivery' } });
      }
    }

    await notifyAdmins(
      'Delivery OTP Verified',
      `OTP verified for Order #${order_id}`,
      'delivery_otp_verified',
      order_id,
      io
    );

    return res.status(200).json({ success: true, valid: true, message: 'OTP verified successfully' });
  } catch (error) {
    console.error('verifyDeliveryOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const returnProduct = async (req, res) => {
  const { order_id, reason } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) }
    });

    if (!order) return res.status(404).json({ success: false, error: { message: 'Order not found' } });

    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: {
        status: 'returned',
        cancelled_reason: reason,
        cancelled_at: getPKTDate(new Date())
      }
    });

    await logOrderStatusChange(parseInt(order_id), order.status, 'returned', req.user);

    const io = req.app.get('io');
    await notifyAdmins(
      'Product Returned',
      `Product for Order #${order_id} has been returned. Reason: ${reason}`,
      'product_returned',
      order_id,
      io
    );

    return res.status(200).json({ success: true, message: 'Product marked as returned' });
  } catch (error) {
    console.error('returnProduct error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const generateRefundOtp = async (req, res) => {
  const { order_id } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) }
    });

    if (!order) return res.status(404).json({ success: false, error: { message: 'Order not found' } });

    const otp = await saveOTP(order.phone, 'refund');
    await sendOTP(order.phone, otp);

    const io = req.app.get('io');
    await notifyAdmins(
      'Refund OTP Generated',
      `OTP sent to customer for refund of Order #${order_id}`,
      'refund_otp_generated',
      order_id,
      io
    );

    return res.status(200).json({ success: true, message: 'Refund OTP sent to customer' });
  } catch (error) {
    console.error('generateRefundOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const verifyRefundOtp = async (req, res) => {
  const { order_id, otp } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) }
    });

    if (!order) return res.status(404).json({ success: false, error: { message: 'Order not found' } });

    const verification = await verifyOTP(order.phone, otp, 'refund');
    if (!verification.valid) {
      return res.status(400).json({ success: true, valid: false, message: verification.message });
    }

    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: { status: 'refunded' }
    });

    await logOrderStatusChange(parseInt(order_id), order.status, 'refunded', req.user);

    const io = req.app.get('io');
    await notifyAdmins(
      'Refund Processed',
      `Refund for Order #${order_id} has been verified and processed`,
      'refund_processed',
      order_id,
      io
    );

    return res.status(200).json({ success: true, valid: true, message: 'Refund verified and processed' });
  } catch (error) {
    console.error('verifyRefundOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const getDeliveryBoyInventory = async (req, res) => {
  try {
    const deliveryBoyId = req.user.id;

    const transfers = await prisma.stockTransfer.findMany({
      where: {
        to_type: 'Delivery Officer',
        to_id: deliveryBoyId,
        status: { in: ['transferred', 'delivered'] }
      },
      include: {
        inventory: {
          select: {
            id: true,
            product_name: true,
            category: true,
            color_variant: true,
            imei_serial: true,
            quantity: true,
            purchase_price: true,
            status: true,
            installment_plans: true,
            sale_price: true,
            api_product_name: true
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    const outletIds = [...new Set(transfers.filter(t => t.from_type === 'Outlet').map(t => t.from_id))];
    const outlets = outletIds.length > 0
      ? await prisma.outlet.findMany({
        where: { id: { in: outletIds } },
        select: { id: true, name: true, code: true }
      })
      : [];

    const groupMap = new Map();

    for (const t of transfers) {
      const key = `${t.inventory.product_name}||${t.inventory.color_variant || ''}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          product_name: t.inventory.product_name,
          category: t.inventory.category,
          color_variant: t.inventory.color_variant || null,
          purchase_price: t.inventory.purchase_price,
          installment_plans: t.inventory.installment_plans,
          sale_price: t.inventory.sale_price || null,
          api_product_name: t.inventory.api_product_name || null,
          total_qty: 0,
          units: []
        });
      }
      const grp = groupMap.get(key);
      const qty = t.quantity_transferred || 1;
      const outlet = outlets.find(o => o.id === t.from_id);
      grp.total_qty += qty;
      grp.units.push({
        transfer_id: t.id,
        transferred_at: t.created_at,
        quantity_transferred: qty,
        imei_serial: t.inventory.imei_serial || null,
        status: 'In Stock',
        outlet: outlet ? { name: outlet.name, code: outlet.code } : null
      });
    }

    const grouped = Array.from(groupMap.values());

    return res.json({ success: true, count: grouped.length, grouped });
  } catch (error) {
    console.error('getDeliveryBoyInventory error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// const pickOrder = async (req, res) => {
//   const { order_id } = req.body;

//   try {
//     if (!order_id) {
//       return res.status(404).json({ success: false, error: { message: 'Order not found' } });
//     }

//     await prisma.order.update({
//       where: { id: parseInt(order_id) },
//       data: { status: 'picked' }
//     });

//     const io = req.app.get('io');
//     await notifyAdmins(
//       'Order Picked',
//       `Order #${order_id} has been picked`,
//       'order_picked',
//       order_id,
//       io
//     );

//     return res.status(200).json({ success: true, message: 'Order status changed to Picked' });
//   } catch (error) {
//     console.error('pickOrder error:', error);
//     return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
//   }
// };

const unpickOrder = async (req, res) => {
  const { order_id, feedback } = req.body;

  try {
    if (!order_id) {
      return res.status(404).json({ success: false, error: { message: 'Order not found' } });
    }

    if (!feedback) {
      return res.status(400).json({ success: false, error: { message: 'Feedback/reason is required' } });
    }

    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: {
        status: 'postponed',
        postponed_feedback: feedback
      }
    });

    await logOrderStatusChange(parseInt(order_id), 'picked', 'postponed', req.user);

    const io = req.app.get('io');
    await notifyAdmins(
      'Order Postponed',
      `Order #${order_id} has been unpicked and postponed. Reason: ${feedback}`,
      'order_unpicked',
      order_id,
      io
    );

    const order = await prisma.order.findUnique({ where: { id: parseInt(order_id) } });
    if (order?.outlet_id) {
      await notifyOutlet(
        order.outlet_id,
        'Order Postponed',
        `Order #${order.order_ref} has been postponed by the officer. Reason: ${feedback}`,
        'order_unpicked',
        order.id,
        io
      );
    }

    return res.status(200).json({ success: true, message: 'Order has been postponed successfully', feedback });
  } catch (error) {
    console.error('unpickOrder error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

// =======================
// RETURN & EXCHANGE MODULE
// =======================

const initiateReturnExchange = async (req, res) => {
  const { order_id, type, is_cash_refund, refund_amount } = req.body; // type = 'Return' or 'Exchange'
  const delivery_officer_id = req.user.id; // Use authenticated officer ID

  if (!order_id || !['Return', 'Exchange'].includes(type)) {
    return res.status(400).json({ success: false, error: 'Valid order_id and type (Return/Exchange) are required.' });
  }

  try {
    // Check if the order was delivered by this officer
    const delivery = await prisma.delivery.findUnique({
      where: { order_id: parseInt(order_id) },
      include: {
        order: {
          include: {
            cash_in_hand: {
              take: 1,
              orderBy: { created_at: 'desc' }
            }
          }
        },
        delivery_agent: { select: { full_name: true, phone: true } }
      }
    });

    if (!delivery || delivery.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'Order is not marked as delivered.' });
    }

    if (delivery.delivery_agent_id !== delivery_officer_id) {
      return res.status(403).json({ success: false, error: 'You are not the designated delivery officer for this order.' });
    }

    // 48-hour verification (Extended from 24h)
    const delivery_time = delivery.end_time || delivery.updated_at;
    const now = getPKTDate(new Date());
    const hoursDifference = (now.getTime() - delivery_time.getTime()) / (1000 * 60 * 60);

    if (hoursDifference > 48) {
      return res.status(400).json({ success: false, error: 'Return/Exchange period has expired (> 48 hours). Please contact the outlet directly.' });
    }

    // Must belong to an outlet
    const outlet_id = delivery.order.outlet_id;
    if (!outlet_id) {
      return res.status(400).json({ success: false, error: 'This order is not associated with an outlet.' });
    }

    // Check if an active return/exchange already exists
    const existing = await prisma.returnExchange.findFirst({
      where: { order_id: parseInt(order_id), status: 'pending' }
    });

    if (existing) {
      return res.status(400).json({ success: false, error: 'A return/exchange request is already pending for this order.' });
    }

    // Generate random 4 digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // 6. Source specific delivery data prioritizing the official CashInHand receipt
    const cashRecord = delivery.order.cash_in_hand?.[0];
    const deliveryPlan = delivery.selected_plan ? (typeof delivery.selected_plan === 'string' ? JSON.parse(delivery.selected_plan) : delivery.selected_plan) : null;

    const deliveredAdvance = cashRecord ? cashRecord.amount : (deliveryPlan?.advance_payment || deliveryPlan?.advance_amount || deliveryPlan?.advancePayment || delivery.order?.advance_amount || 0);
    const productName = cashRecord?.product_name || deliveryPlan?.productName || delivery.order?.product_name;
    const imei = cashRecord?.imei_serial || delivery.product_imei;

    // Split color/variant from CashInHand snapshot first
    let color = 'N/A';
    let variant = 'N/A';
    if (cashRecord?.color_variant) {
      const parts = cashRecord.color_variant.split('|').map(s => s.trim());
      color = parts[0] || 'N/A';
      variant = parts[1] || 'N/A';
    } else {
      color = deliveryPlan?.color || deliveryPlan?.productColor || 'N/A';
      variant = deliveryPlan?.variant || deliveryPlan?.productVariant || 'N/A';
    }

    // Securely log the intent (Storing extra specs in selected_plan JSON to avoid schema conflicts)
    const returnRecord = await prisma.returnExchange.create({
      data: {
        order_id: parseInt(order_id),
        delivery_officer_id,
        outlet_id,
        type,
        status: 'pending',
        otp,
        product_name: productName,
        // Robust storage of snapshot specs
        selected_plan: {
          ...deliveryPlan,
          delivered_color: color,
          delivered_variant: variant,
          delivered_advance_amount: parseFloat(deliveredAdvance) || 0
        },
        imei_returned: imei,
        is_cash_refund: !!is_cash_refund,
        refund_amount: parseFloat(refund_amount) || 0,
        initiated_by: "DeliveryOfficer"
      }
    });

    // Send OTP to Delivery Officer via WhatsApp (Wati)
    const officerPhone = delivery.delivery_agent?.phone;
    const officerName = delivery.delivery_agent?.full_name || 'Officer';
    if (officerPhone) {
      try {
        await sendOTP(officerPhone, otp);
        console.log(`Return/Exchange OTP ${otp} sent to officer ${officerName} at ${officerPhone}`);
      } catch (err) {
        console.error('Error sending Return/Exchange OTP to officer:', err);
      }
    }

    // Emit socket event to outlet room so the popup opens
    const io = req.app.get('io');
    if (io) {
      io.to(`outlet_${outlet_id}`).emit('return_exchange_requested', {
        record_id: returnRecord.id,
        officer_name: officerName,
        type,
        otp,
        order_ref: delivery.order.order_ref || `#${order_id}`,
        product_name: productName,
        color: color,
        variant: variant,
        delivered_advance: deliveredAdvance,
        imei: imei || null,
        is_cash_refund: returnRecord.is_cash_refund,
        refund_amount: returnRecord.refund_amount
      });

      // Save notification to DB for Outlet Users
      await notifyOutlet(
        outlet_id,
        `${type} Requested`,
        `${officerName} has requested a ${type} for Order #${delivery.order.order_ref}.`,
        'return_exchange_requested',
        returnRecord.id,
        io
      );
    }

    return res.json({
      success: true,
      message: `${type} request initiated successfully. Please hand over the item to the outlet and provide this OTP.`,
      otp,
      data: returnRecord
    });
  } catch (error) {
    console.error('initiateReturnExchange error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

const getDeliveryOfficerOTPLogs = async (req, res) => {
  const deliveryBoyId = req.user?.id;

  if (!deliveryBoyId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  try {
    const logs = await prisma.otpLog.findMany({
      where: {
        user_id: deliveryBoyId,
        action: { in: ["stock_transfer_otp", "cash_submission_otp"] }
      },
      orderBy: { created_at: 'desc' }
    });

    return res.status(200).json({
      success: true,
      data: logs
    });
  } catch (error) {
    console.error('getDeliveryOfficerOTPLogs error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error while fetching OTP logs' });
  }
};

/**
 * POST /orders/self-pickup/submit
 * Handles Self Pickup delivery directly from the branch
 */
const submitSelfPickupDelivery = async (req, res) => {
  const { order_id, product_imei, selected_plan, phone, feedback } = req.body;
  const outlet_id = req.user.outlet_id;

  if (!outlet_id) {
    return res.status(403).json({ success: false, message: 'Not an outlet user.' });
  }

  if (!order_id) {
    return res.status(400).json({ success: false, message: 'order_id is required' });
  }

  try {
    // 1. Fetch Order and Verify Outlet
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        delivery: true,
        verification: { include: { purchaser: true } }
      }
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.outlet_id !== outlet_id) {
      return res.status(403).json({ success: false, message: 'Order does not belong to your outlet' });
    }

    if (order.delivery) {
      return res.status(400).json({ success: false, message: 'Delivery already submitted for this order' });
    }

    // 2. Update purchaser phone number if provided
    if (phone && order.verification?.purchaser) {
      await prisma.purchaserVerification.update({
        where: { id: order.verification.purchaser.id },
        data: { telephone_number: phone }
      });
      order.verification.purchaser.telephone_number = phone;
    }

    // 2.1 Process face photo
    const facePhotos = req.files['face_photo'] || [];

    // 3. Process Plan & Advance
    let advanceAmount = 0.0;
    let planObj = null;

    if (selected_plan) {
      try {
        planObj = typeof selected_plan === 'string' ? JSON.parse(selected_plan) : selected_plan;
        if (planObj && (planObj.advance !== undefined || planObj.advance_amount !== undefined)) {
          advanceAmount = parseFloat(planObj.advance || planObj.advance_amount);
        }
      } catch (e) {
        console.error('Error parsing selected_plan:', e);
      }
    }

    const purchaser = order.verification?.purchaser;
    const confirmedCustomerName = purchaser?.name || purchaser?.full_name || order.customer_name;
    // 4. Start Transaction for Inventory, Delivery, Order and Financials
    const result = await prisma.$transaction(async (tx) => {
      let colorVariant = null;
      let productNameSnapshot = order.product_name;

      // Update Inventory if IMEI provided
      if (product_imei) {
        const inventory = await tx.outletInventory.findFirst({
          where: { imei_serial: product_imei, outlet_id }
        });

        if (inventory) {
          await tx.outletInventory.update({
            where: { id: inventory.id },
            data: { status: 'Sold' }
          });
          colorVariant = inventory.color_variant || null;
          productNameSnapshot = inventory.product_name;

          // Log Stock Transfer from Outlet to Customer
          await tx.stockTransfer.create({
            data: {
              inventory_id: inventory.id,
              from_type: 'Outlet',
              from_id: outlet_id,
              to_type: 'Customer',
              to_id: order.id,
              status: 'completed',
              quantity_transferred: 1
            }
          });
        }
      }

      // Create delivery record
      const delivery = await tx.delivery.create({
        data: {
          order_id: parseInt(order_id),
          delivery_agent_id: req.user.id, // The branch user who processed the self-pickup
          status: 'completed',
          start_time: getPKTDate(new Date()),
          end_time: getPKTDate(new Date()),
          verified: true,
          product_imei: product_imei || null,
          selected_plan: selected_plan || null,
          self_pickup: true,
          feedback: feedback || null
        }
      });

      // Create uploads if any
      if (facePhotos.length > 0) {
        await tx.deliveryUpload.createMany({
          data: facePhotos.map(file => ({
            delivery_id: delivery.id,
            upload_type: 'face_photo',
            file_url: file.url || file.path, // handle both cases
            uploaded_at: getPKTDate(new Date())
          }))
        });
      }

      // Update order status
      await tx.order.update({
        where: { id: parseInt(order_id) },
        data: {
          status: 'delivered',
          is_delivered: true
        }
      });

      // Create Cash In Hand entry for advance (marked as paid since it's collected at branch)
      if (advanceAmount > 0) {
        await tx.cashInHand.create({
          data: {
            officer_id: req.user.id,
            outlet_id: outlet_id,
            order_id: parseInt(order_id),
            amount: advanceAmount,
            submitted_amount: advanceAmount,
            status: 'paid',
            customer_name: confirmedCustomerName,
            product_name: productNameSnapshot,
            imei_serial: product_imei || null,
            color_variant: colorVariant || null,
            payment_method: 'Cash',
            cash_type: 'Down payment (Self Pickup)',
            created_at: getPKTDate(new Date())
          }
        });

        // Update Cash Register - Down Payments
        await updateCashRegister(tx, outlet_id, 'down_payments', advanceAmount, 'add');
      }

      return { delivery, productNameSnapshot, colorVariant };
    }, {
      maxWait: 5000,
      timeout: 20000
    });

    const { delivery, productNameSnapshot, colorVariant } = result;

    await logOrderStatusChange(parseInt(order_id), order.status, 'delivered', req.user);

    // 5. Build Installment Ledger
    let installmentLedger = null;
    let ledgerUrl = null;
    try {
      const monthlyAmt = planObj?.monthly_amount || planObj?.monthlyAmount || order.monthly_amount || 0;
      const totalMonths = planObj?.months || planObj?.duration || order.months || 0;
      const deliveryDate = new Date();

      if (totalMonths > 0 && monthlyAmt > 0) {
        let ledgerRows = [];

        // Use custom ledger from frontend if provided (user edited dates/amounts)
        let customLedger = null;
        try {
          const raw = req.body.custom_ledger;
          if (raw) customLedger = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) { /* ignore parse errors */ }

        // Advance row always first
        ledgerRows.push({
          month: 0,
          label: 'Advance Payment',
          due_date: deliveryDate.toISOString(),
          amount: parseFloat(advanceAmount || 0),
          status: 'paid',
          paid_at: deliveryDate.toISOString(),
          payment_method: 'Cash',
          feedback: 'Self Pickup at Branch'
        });

        if (customLedger && Array.isArray(customLedger) && customLedger.length === totalMonths) {
          // Use edited installment rows from the UI
          customLedger.forEach((row, i) => {
            ledgerRows.push({
              month: i + 1,
              label: `Month ${i + 1}`,
              due_date: row.date ? new Date(row.date).toISOString() : addMonths(deliveryDate, i + 1).toISOString(),
              amount: parseFloat(row.amount) || parseFloat(monthlyAmt),
              status: 'pending',
              paid_at: null,
            });
          });
        } else {
          // Auto-generate installment rows
          for (let i = 0; i < totalMonths; i++) {
            ledgerRows.push({
              month: i + 1,
              label: `Month ${i + 1}`,
              due_date: addMonths(deliveryDate, i + 1).toISOString(),
              amount: parseFloat(monthlyAmt),
              status: 'pending',
              paid_at: null,
            });
          }
        }

        const ledgerToken = jwt.sign(
          { order_id: parseInt(order_id), delivery_id: delivery.id },
          LEDGER_TOKEN_SECRET,
          { expiresIn: '730d' }
        );
        const shortId = crypto.randomBytes(5).toString('hex');
        ledgerUrl = `${ledgerToken}`;

        installmentLedger = await prisma.installmentLedger.create({
          data: {
            order_id: parseInt(order_id),
            delivery_id: delivery.id,
            token: ledgerToken,
            short_id: shortId,
            ledger_rows: ledgerRows,
          }
        });

        // -------------------------------------------------------------
        // TPS / 1BILL CONSUMER NUMBER GENERATION FOR SELF PICKUP
        // -------------------------------------------------------------
        const mobile = purchaser?.telephone_number || order.whatsapp_number;
        const consumerNo = await generateConsumerNumber(product_imei, mobile);

        let firstMonthDue = 0;
        let dueDate = getPKTDate();
        let billingMonthStr = "0000";

        if (Array.isArray(ledgerRows) && ledgerRows.length > 1) {
          // Row 1 is Month 1 since Row 0 is Advance Payment
          firstMonthDue = ledgerRows[1].amount || 0;
          if (ledgerRows[1].due_date) {
            const d = new Date(ledgerRows[1].due_date);
            if (!isNaN(d.getTime())) {
              dueDate = d;
              billingMonthStr = String(d.getFullYear()).slice(-2) + String(d.getMonth() + 1).padStart(2, '0');
            }
          }
        }

        try {
          await prisma.consumerNumber.create({
            data: {
              consumer_number: consumerNo,
              ledger_id: installmentLedger.id,
              delivery_id: delivery.id,
              customer_name: confirmedCustomerName || order.customer_name || 'N/A',
              mobile_number: mobile || 'N/A',
              imei_serial: product_imei || null,
              amount_due: firstMonthDue,
              billing_month: billingMonthStr,
              due_date: dueDate,
              bill_status: 'U', // Unpaid
            }
          });
        } catch (consumerErr) {
          console.error('[submitSelfPickupDelivery] Failed to create ConsumerNumber (Non-fatal):', consumerErr);
        }

      }

    } catch (ledgerErr) {
      console.error('[submitSelfPickupDelivery] Ledger creation error:', ledgerErr);
    }

    // 6. WATI Messages
    const customerPhone = purchaser?.telephone_number;
    const deliveryDateStr = formatDatePK(new Date());
    if (customerPhone) {
      sendDeliveryConfirmation(customerPhone, {
        customerName: confirmedCustomerName,
        productName: productNameSnapshot,
        imei: product_imei || 'N/A',
        colorVariant: colorVariant || 'N/A',
        advanceAmount,
        deliveryDate: deliveryDateStr,
        orderRef: order.order_ref,
        orderStatus: 'Delivered (Self Pickup)',
      }).catch(e => console.error('[WATI] Delivery confirmation error:', e));

      if (installmentLedger && ledgerUrl) {
        const rows = installmentLedger.ledger_rows;
        const totalRemain = rows.reduce((s, r) => s + (r.amount || 0), 0);
        sendInstallmentLedger(customerPhone, {
          customerName: confirmedCustomerName,
          productName: productNameSnapshot,
          orderRef: order.order_ref,
          nextMonthLabel: 'Mahina 1',
          monthlyAmount: rows[1]?.amount || 0,
          dueDate: rows[1] ? formatDatePK(rows[1].due_date) : 'N/A',
          totalRemaining: totalRemain,
          ledgerUrl,
        }).catch(e => console.error('[WATI] Ledger template error:', e));
      }
    }

    // 7. Success Response
    const io = req.app.get('io');
    await notifyAdmins(
      'Self Pickup Completed',
      `Order #${order.order_ref} picked up at Branch (Outlet ID: ${outlet_id}) by ${req.user.full_name}`,
      'delivery_complete',
      delivery.id,
      io
    );

    await notifyOutlet(
      outlet_id,
      'Self Pickup Completed',
      `Order #${order.order_ref} has been picked up by the customer at your branch.`,
      'delivery_complete',
      delivery.id,
      io
    );

    return res.status(201).json({
      success: true,
      message: 'Self Pickup processed successfully',
      data: { delivery, ledger_url: ledgerUrl }
    });

  } catch (error) {
    console.error('submitSelfPickupDelivery error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Replace a delivery upload photo (Super Admin only)
const replaceDeliveryUpload = async (req, res) => {
  const { upload_id } = req.params;

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  try {
    const existing = await prisma.deliveryUpload.findUnique({
      where: { id: parseInt(upload_id) }
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Upload not found' });
    }

    const updated = await prisma.deliveryUpload.update({
      where: { id: parseInt(upload_id) },
      data: {
        file_url: req.file.url,
        uploaded_at: getPKTDate(new Date())
      },
      include: {
        delivery: {
          include: {
            order: {
              include: {
                verification: true
              }
            }
          }
        }
      }
    });

    // Log to edit history (if verification exists)
    if (updated.delivery.order.verification) {
      await prisma.verificationEditHistory.create({
        data: {
          verification_id: updated.delivery.order.verification.id,
          entity_type: 'delivery_upload',
          entity_id: updated.id,
          field_name: 'file_url',
          old_value: existing.file_url,
          new_value: updated.file_url,
          edited_by_id: req.user.id,
          edited_by_name: req.user.full_name,
          edited_at: getPKTDate(new Date())
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Delivery upload replaced successfully',
      data: { upload: updated }
    });
  } catch (error) {
    console.error('Replace delivery upload error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

module.exports = {
  submitDelivery,
  getDeliveryByOrderId,
  getPendingDeliveryProducts,
  getCashInHand,
  generateDeliveryOtp,
  verifyDeliveryOtp,
  returnProduct,
  generateRefundOtp,
  verifyRefundOtp,
  getDeliveryBoyInventory,
  // pickOrder,
  unpickOrder,
  submitCashToOutlet,
  initiateReturnExchange,
  getDeliveryOfficerOTPLogs,
  submitSelfPickupDelivery,
  replaceDeliveryUpload
};
