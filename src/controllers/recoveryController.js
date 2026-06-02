const prisma = require('../../lib/prisma');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const {
  sendOTP,
  sendInstallmentPaymentReceipt,
  sendPartialInstallmentPaymentReceipt,
  sendNextInstallmentReminder
} = require('../services/watiService');
const { logAction } = require('../utils/auditLogger');
const { getNormalizedLedger, normalizeLedger } = require('../utils/ledgerUtils');
const { createOfficerTransaction } = require('../utils/officerTransactionUtils');

const getExpectedWorkMinutes = (startStr, endStr) => {
  if (!startStr || !endStr) return 480; // 8h default
  const parseTime = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  let diff = parseTime(endStr) - parseTime(startStr);
  if (diff < 0) diff += 24 * 60;
  return diff;
};

const getAllRecoveryOfficers = async (req, res) => {
  try {
    const officers = await prisma.user.findMany({
      where: { role: { name: 'Recovery Officer' } },
      select: {
        id: true,
        full_name: true,
        username: true,
        phone: true,
        status: true,
        is_online: true,
        last_known_latitude: true,
        last_known_longitude: true,
        last_online_at: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        recovery_orders: {
          where: { status: 'delivered' }, // Active recovery jobs
          select: {
            id: true,
            status: true,
            order_ref: true,
            customer_name: true,
          },
          take: 1,
        },
      },
      orderBy: { full_name: 'asc' },
    });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyStatsRaw = await prisma.officerSession.groupBy({
      by: ['officer_id'],
      where: { start_time: { gte: startOfMonth } },
      _sum: { duration_minutes: true },
    });

    const monthlyStatsMap = new Map(
      monthlyStatsRaw.map((s) => [s.officer_id, ((s._sum.duration_minutes || 0) / 60).toFixed(2)])
    );

    const formatted = officers.map((o) => ({
      id: o.id,
      full_name: o.full_name,
      username: o.username,
      phone: o.phone,
      account_status: o.status,
      is_online: o.is_online,
      current_location:
        o.is_online && o.last_known_latitude
          ? { latitude: o.last_known_latitude, longitude: o.last_known_longitude }
          : null,
      last_known_location:
        !o.is_online && o.last_known_latitude
          ? {
            latitude: o.last_known_latitude,
            longitude: o.last_known_longitude,
            timestamp: o.last_online_at,
          }
          : null,
      bike_km_range: o.bike_km_range,
      working_hours:
        o.working_hours_start && o.working_hours_end
          ? `${o.working_hours_start} - ${o.working_hours_end}`
          : null,
      current_assignment: o.recovery_orders[0] ? {
        id: o.recovery_orders[0].id,
        status: o.recovery_orders[0].status,
        order: {
          order_ref: o.recovery_orders[0].order_ref,
          customer_name: o.recovery_orders[0].customer_name
        }
      } : null,
      monthly_online_hours: monthlyStatsMap.get(o.id) || '0.00',
    }));

    return res.json({ success: true, data: { officers: formatted } });
  } catch (error) {
    console.error('getAllRecoveryOfficers error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getRecoveryOfficerStats = async (req, res) => {
  const { id } = req.params;
  const { month, year } = req.query;

  try {
    const officer = await prisma.user.findUnique({
      where: { id: parseInt(id) },
      select: { working_hours_start: true, working_hours_end: true },
    });

    if (!officer) return res.status(404).json({ success: false, error: 'Officer not found' });

    let startDate, endDate;
    if (year && month) {
      startDate = new Date(Number(year), Number(month) - 1, 1);
      endDate = new Date(Number(year), Number(month), 0);
    } else {
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    }

    const sessions = await prisma.officerSession.findMany({
      where: {
        officer_id: parseInt(id),
        start_time: { gte: startDate, lte: endDate },
      },
      select: { start_time: true, duration_minutes: true },
    });

    const dailyMap = new Map();
    sessions.forEach((s) => {
      const dateKey = s.start_time.toISOString().split('T')[0];
      dailyMap.set(dateKey, (dailyMap.get(dateKey) || 0) + (s.duration_minutes || 0));
    });

    const expectedDailyMin = getExpectedWorkMinutes(officer.working_hours_start, officer.working_hours_end);
    const expectedDailyHours = (expectedDailyMin / 60).toFixed(2);

    const dailyStats = [];
    let current = new Date(startDate);
    while (current <= endDate) {
      const dateKey = current.toISOString().split('T')[0];
      const onlineMin = dailyMap.get(dateKey) || 0;
      const onlineHours = (onlineMin / 60).toFixed(2);
      const offlineDuringWork = Math.max(0, Number(expectedDailyHours) - Number(onlineHours)).toFixed(2);

      dailyStats.push({
        date: dateKey,
        online_hours: onlineHours,
        worked_hours: onlineHours,
        offline_during_work_hours: offlineDuringWork,
      });

      current.setDate(current.getDate() + 1);
    }

    return res.json({
      success: true,
      data: {
        officer_id: Number(id),
        month: startDate.toISOString().slice(0, 7),
        daily_stats: dailyStats,
        expected_daily_hours: expectedDailyHours,
      },
    });
  } catch (error) {
    console.error('getRecoveryOfficerStats error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const getRecoveryCustomers = async (req, res) => {
  const officerId = req.user.id;

  try {
    const orders = await prisma.order.findMany({
      where: {
        recovery_officer_id: officerId,
        is_delivered: true,
      },
      include: {
        verification: {
          include: {
            purchaser: true,
            documents: {
              where: { document_type: 'photo', person_type: 'purchaser' },
              orderBy: { uploaded_at: 'desc' },
              take: 1,
            },
          },
        },
        delivery: {
          include: {
            installment_ledger: true,
          },
        },
        cash_in_hand: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
      orderBy: { updated_at: 'desc' },
    });

    if (orders.length === 0) {
      return res.status(200).json({ success: true, data: { customers: [] } });
    }

    // ── Pre-fetch Inventory details based on IMEI ──────────────────
    const allImeis = orders
      .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
      .filter(Boolean);

    const inventories = await prisma.outletInventory.findMany({
      where: { imei_serial: { in: allImeis } },
      select: { imei_serial: true, product_name: true, color_variant: true }
    });

    const inventoryMap = new Map();
    for (const inv of inventories) {
      if (inv.imei_serial) {
        inventoryMap.set(inv.imei_serial, inv);
      }
    }

    const customerMap = new Map();

    for (const order of orders) {
      const key = `order-${order.id}`;

      const purchaser = order.verification?.purchaser || null;
      const cashInHand = order.cash_in_hand?.[0] || null;
      const delivery = order.delivery;
      const installmentLedgerModel = delivery?.installment_ledger || null;
      const profilePhoto = order.verification?.documents?.[0]?.file_url || null;

      // ── Customer details: purchaser se, fallback Order ────────
      const customerName = purchaser?.name;
      const fatherHusbandName = purchaser?.father_husband_name || null;
      const cnicNumber = purchaser?.cnic_number || null;
      const presentAddress = purchaser?.present_address || null;
      const permanentAddress = purchaser?.permanent_address || null;
      const telephoneNumber = purchaser?.telephone_number || order.whatsapp_number;
      const nearestLocation = purchaser?.nearest_location || null;

      if (!customerMap.has(key)) {
        customerMap.set(key, {
          customer: {
            name: customerName,
            father_husband_name: fatherHusbandName,
            cnic_number: cnicNumber,
            whatsapp_number: order.whatsapp_number,
            telephone_number: telephoneNumber,
            present_address: presentAddress,
            permanent_address: permanentAddress,
            nearest_location: nearestLocation,
            city: order.city,
            area: order.area,
            profile_photo: profilePhoto,
          },
          orders: [],
        });
      }

      const group = customerMap.get(key);

      // ── Delivery status ────────────────────────────────────────
      const isDelivered = order.is_delivered || delivery?.status === 'completed';
      const deliveryDate = isDelivered ? (delivery?.end_time || order.updated_at) : null;

      // ── Product info: Fetch from Inventory via IMEI first ───────────────────────────
      const imeiSerial = cashInHand?.imei_serial || delivery?.product_imei || order.imei_serial || null;
      const invInfo = imeiSerial ? inventoryMap.get(imeiSerial) : null;

      const productName = invInfo?.product_name || cashInHand?.product_name || order.product_name || null;
      const colorVariant = invInfo?.color_variant || cashInHand?.color_variant || null;

      // ── Plan info: Delivery.selected_plan se ──────────────────
      let selectedPlan = delivery?.selected_plan || null;
      if (typeof selectedPlan === 'string') {
        try { selectedPlan = JSON.parse(selectedPlan); } catch { selectedPlan = null; }
      }

      // ── Use normalized ledger for consistent financial calculations ──
      const normalized = getNormalizedLedger(installmentLedgerModel?.ledger_rows);
      const { advance_payment: advancePayment, installment_ledger: installmentLedger, summary } = normalized;

      const advanceAmount = advancePayment.amount;
      const monthlyAmount = installmentLedger[0]?.dueAmount || Number(selectedPlan?.monthly_amount || selectedPlan?.monthlyAmount || 0);
      const totalMonths = installmentLedger.length || Number(selectedPlan?.months || selectedPlan?.totalMonths || 0);

      group.orders.push({
        id: order.id,
        order_ref: order.order_ref,
        status: order.status,
        is_delivered: isDelivered,
        delivery_date: deliveryDate,

        product_details: {
          product_name: productName,
          imei_serial: imeiSerial,
          color_variant: colorVariant,
        },

        plan: {
          selected_plan: selectedPlan,
          advance_amount: advanceAmount,
          monthly_amount: monthlyAmount,
          months: totalMonths,
          total_plan_value: summary.grandTotalDue,
        },

        ledger: {
          advance_payment: advancePayment,
          installment_ledger: installmentLedger,
          ledger_token: installmentLedgerModel?.short_id || null,
          summary: summary,
        },
      });
    }

    return res.json({
      success: true,
      data: { customers: Array.from(customerMap.values()) },
    });
  } catch (error) {
    console.error('getRecoveryCustomers error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};


const getCollectionStats = async (req, res) => {
  const officerId = req.user.id;

  try {
    const cashEntries = await prisma.cashInHand.findMany({
      where: {
        officer_id: officerId,
        status: 'pending',
      }
    });

    const totalCashInHand = cashEntries.reduce((sum, entry) => {
      return sum + (entry.amount - (entry.submitted_amount || 0));
    }, 0);

    const recentCollections = await prisma.cashInHand.findMany({
      where: { officer_id: officerId },
      orderBy: { created_at: 'desc' },
      take: 10,
      include: { order: { select: { order_ref: true } } }
    });

    return res.json({
      success: true,
      data: {
        cashInHand: totalCashInHand,
        recentCollections: recentCollections.map(c => ({
          ...c,
          customer_name: c.customer_name,
          paymentType: 'installment'
        }))
      }
    });
  } catch (error) {
    console.error('getCollectionStats error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

const getDueOverdueInstallments = async (req, res) => {
  const officerId = req.user.id;

  try {
    const orders = await prisma.order.findMany({
      where: { recovery_officer_id: officerId, is_delivered: true },
      include: { installment_ledger: true, delivery: true }
    });

    const overdue = [];
    const now = new Date();

    for (const order of orders) {
      const rows = normalizeLedger(order.installment_ledger.ledger_rows);

      for (const row of rows) {
        if (row.month === 0) continue;
        const dueDate = new Date(row.due_date || row.dueDate);
        if (dueDate < now && row.status !== 'paid') {
          overdue.push({
            order_id: order.id,
            order_ref: order.order_ref,
            customer_name: order.customer_name,
            whatsapp_number: order.whatsapp_number,
            address: order.address,
            monthNumber: row.month,
            dueDate: dueDate.toISOString().split('T')[0],
            amount: row.dueAmount,
            paidAmount: row.paidAmount,
            remainingAmount: row.remainingAmount
          });
        }
      }
    }
    return res.json({ success: true, data: { overdue } });
  } catch (error) {
    console.error('getDueOverdueInstallments error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

const submitCollections = async (req, res) => {
  const officerId = req.user.id;

  try {
    const pendingEntries = await prisma.cashInHand.findMany({
      where: {
        officer_id: officerId,
        status: 'pending',
      }
    });

    const totalAmount = pendingEntries.reduce((sum, entry) => {
      return sum + (entry.amount - (entry.submitted_amount || 0));
    }, 0);

    return res.json({
      success: true,
      data: {
        count: pendingEntries.length,
        totalAmount,
        message: 'Pending collections ready for outlet submission'
      }
    });
  } catch (error) {
    console.error('submitCollections error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// =====================
// INSTALLMENT PAYMENT MODULE (RECOVERY)
// =====================

// API 1: OTP generate karke purchaser ko bhejo
const generateInstallmentOtp = async (req, res) => {
  const { order_id } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: { include: { purchaser: true } }
      }
    });

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
    if (!phone) return res.status(400).json({ success: false, message: 'Customer phone number not found' });

    const otp = await saveOTP(phone, 'installment_payment');
    await sendOTP(phone, otp);

    return res.json({ success: true, message: 'OTP sent to customer' });
  } catch (error) {
    console.error('generateInstallmentOtp error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// API for logging visit ONLY (when payment is NOT collected)
const logRecoveryVisit = async (req, res) => {
  const { order_id, latitude, longitude, customer_feedback, visit_notes } = req.body;
  const officerId = req.user?.id || 24;

  // Extract uploaded files
  const visitPhotos = req.files?.['visit_photos'] || [];
  const profilePhotoFile = req.files?.['profile_photo']?.[0] || null;

  // Validate photo counts
  if (visitPhotos.length > 5) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Maximum 5 visit photos allowed' }
    });
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: { include: { documents: { where: { document_type: 'photo', person_type: 'purchaser' }, orderBy: { uploaded_at: 'desc' }, take: 1 } } }
      }
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Use transaction for visit and photos
    const result = await prisma.$transaction(async (tx) => {
      const visit = await tx.recoveryVisit.create({
        data: {
          order_id: parseInt(order_id),
          officer_id: officerId,
          latitude: latitude ? parseFloat(latitude) : null,
          longitude: longitude ? parseFloat(longitude) : null,
          visit_time: new Date(),
          customer_feedback,
          visit_notes,
          payment_collected: false,
          amount_collected: null,
        }
      });

      // Prepare photo records for batch insert
      const photoRecords = [];

      // Add profile photo (from upload or from verification)
      let profilePhotoUrl = profilePhotoFile?.url || null;
      if (!profilePhotoUrl && order.verification?.documents?.[0]?.file_url) {
        profilePhotoUrl = order.verification.documents[0].file_url;
      }

      if (profilePhotoUrl) {
        photoRecords.push({
          recovery_visit_id: visit.id,
          file_url: profilePhotoUrl,
          photo_type: 'profile'
        });
      }

      // Add visit photos
      visitPhotos.forEach((file) => {
        photoRecords.push({
          recovery_visit_id: visit.id,
          file_url: file.url,
          photo_type: 'visit_location'
        });
      });

      // Batch insert all photos
      if (photoRecords.length > 0) {
        await tx.recoveryVisitPhoto.createMany({
          data: photoRecords
        });
      }

      return visit;
    });

    return res.json({ success: true, message: 'Recovery visit logged successfully with photos', visit: result });
  } catch (error) {
    console.error('logRecoveryVisit error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

const submitInstallment = async (req, res) => {
  const {
    order_id, month_number, amount, payment_method, feedback, fuelCharges,
    latitude, longitude, visit_notes
  } = req.body;
  const officerId = req.user?.id;

  // Extract uploaded files
  const visitPhotos = req.files?.['visit_photos'] || [];
  const profilePhotoFile = req.files?.['profile_photo']?.[0] || null;

  // Validate photo counts
  if (visitPhotos.length > 5) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Maximum 5 visit photos allowed' }
    });
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: { include: { purchaser: true, documents: { where: { document_type: 'photo', person_type: 'purchaser' }, orderBy: { uploaded_at: 'desc' }, take: 1 } } },
        installment_ledger: true,
        delivery: true,
        cash_in_hand: { orderBy: { created_at: 'desc' }, take: 1 }
      }
    });

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Ledger check
    const ledger = order.installment_ledger;
    if (!ledger) return res.status(404).json({ success: false, message: 'Ledger not found' });

    let rows = normalizeLedger(Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : []);
    const rowIndex = rows.findIndex(r => (r.month == month_number || r.monthNumber == month_number));

    if (rowIndex === -1) return res.status(404).json({ success: false, message: 'Installment month not found in ledger' });
    if (rows[rowIndex].status === 'paid') return res.status(400).json({ success: false, message: 'Installment already paid' });

    const dueAmount = parseFloat(rows[rowIndex].amount || rows[rowIndex].dueAmount || 0);
    const existingPaid = parseFloat(rows[rowIndex].paid_amount || 0);
    const payingNow = amount !== undefined ? parseFloat(amount) : (dueAmount - existingPaid);
    const totalPaid = existingPaid + payingNow;

    if (totalPaid > dueAmount + 1) { // 1 PKR margin for rounding
      return res.status(400).json({ success: false, message: `Payment exceeds due amount. Remaining is ${dueAmount - existingPaid}` });
    }

    const imeiSerial = order.cash_in_hand?.[0]?.imei_serial || order.delivery?.product_imei || order.imei_serial;
    const finalProductName = order.cash_in_hand?.[0]?.product_name || order.product_name;

    // DB Transaction
    await prisma.$transaction(async (tx) => {
      rows[rowIndex].paid_amount = totalPaid;
      rows[rowIndex].paid_at = new Date();
      rows[rowIndex].payment_method = payment_method;
      rows[rowIndex].feedback = feedback;
      rows[rowIndex].collected_by = officerId;
      rows[rowIndex].fuel_charges = parseFloat(fuelCharges || 0);

      if (totalPaid >= dueAmount) {
        rows[rowIndex].status = 'paid';
      } else if (totalPaid > 0) {
        rows[rowIndex].status = 'partial';
      } else {
        rows[rowIndex].status = 'pending';
      }

      await tx.installmentLedger.update({
        where: { id: ledger.id },
        data: { ledger_rows: rows }
      });

      // CashInHand entry (sirf cash payment ke liye)
      const isCash = ['cash', 'recovery_cash', 'recovery cash'].includes(payment_method?.toLowerCase());
      console.log('Is cash payment:', isCash, 'Payment method:', payment_method);
      if (isCash) {
        await tx.cashInHand.create({
          data: {
            officer_id: officerId,
            order_id: order.id,
            amount: payingNow,
            status: 'pending',
            customer_name: order.verification?.purchaser?.name || order.customer_name,
            product_name: finalProductName,
            imei_serial: imeiSerial || order.imei_serial,
            payment_method: payment_method,
            cash_type: 'Installment payment',         
            submitted_amount: 0,                                              
            created_at: new Date(),
          }
        });

        // Create Officer Transaction for this credit
        await createOfficerTransaction({
          officer_id: officerId,
          type: 'credit',
          amount: payingNow,
          status: 'pending',
          description: `Installment payment collected from ${order.verification?.purchaser?.name || order.customer_name}`,
          payment_method: payment_method,
          order_ref: order.order_ref
        }, tx);
      }

      // Log the recovery visit along with payment
      const visit = await tx.recoveryVisit.create({
        data: {
          order_id: parseInt(order_id),
          officer_id: officerId,
          latitude: latitude ? parseFloat(latitude) : null,
          longitude: longitude ? parseFloat(longitude) : null,
          visit_time: new Date(),
          customer_feedback: feedback,
          visit_notes: visit_notes,
          payment_collected: true,
          amount_collected: payingNow,
        }
      });

      // Prepare photo records for batch insert
      const photoRecords = [];

      let profilePhotoUrl = profilePhotoFile?.url || null;

      if (profilePhotoUrl) {
        photoRecords.push({
          recovery_visit_id: visit.id,
          file_url: profilePhotoUrl,
          photo_type: 'profile'
        });
      }

      // Add visit photos
      visitPhotos.forEach((file, index) => {
        photoRecords.push({
          recovery_visit_id: visit.id,
          file_url: file.url,
          photo_type: 'visit_location'
        });
      });

      // Batch insert all photos
      if (photoRecords.length > 0) {
        await tx.recoveryVisitPhoto.createMany({
          data: photoRecords
        });
      }
    });

    // Wati Notifications
    const customerName = order.verification?.purchaser?.name || order.customer_name;
    const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;

    if (totalPaid >= dueAmount) {
      sendInstallmentPaymentReceipt(phone, {
        customerName,
        amount: payingNow,
        productName: finalProductName,
        orderRef: order.order_ref,
        date: new Date().toLocaleDateString('en-PK')
      }).catch(err => console.error('Wati Receipt Error:', err));
    } else {
      sendPartialInstallmentPaymentReceipt(phone, {
        customerName,
        paidAmount: payingNow,
        remainingAmount: Math.max(0, dueAmount - totalPaid),
        productName: finalProductName,
        orderRef: order.order_ref,
        dueDate: new Date(rows[rowIndex].due_date || rows[rowIndex].dueDate).toLocaleDateString('en-PK')
      }).catch(err => console.error('Wati Partial Receipt Error:', err));
    }

    const nextRow = rows[rowIndex + 1];
    if (nextRow) {
      sendNextInstallmentReminder(phone, {
        customerName,
        productName: finalProductName,
        monthlyAmount: nextRow.amount || nextRow.dueAmount,
        dueDate: new Date(nextRow.due_date || nextRow.dueDate).toLocaleDateString('en-PK'),
        ledgerUrl: ledger.token ? `${ledger.token}` : null
      }).catch(err => console.error('Wati Reminder Error:', err));
    }

    // await logAction(
    //   req,
    //   'INSTALLMENT_COLLECTION',
    //   `Collected PKR ${paidAmount} from ${customerName} for order ${order.order_ref} (Month: ${month_number}).`,
    //   order.id,
    //   'Order'
    // );

    return res.json({ success: true, message: 'Payment processed successfully' });
  } catch (error) {
    console.error('verifyAndSubmitInstallment error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getOrderRecoveryVisits = async (req, res) => {
  const { order_id } = req.params;

  try {
    const recoveryVisits = await prisma.recoveryVisit.findMany({
      where: { order_id: parseInt(order_id) },
      include: {
        officer: {
          select: {
            id: true,
            full_name: true,
            username: true,
            phone: true
          }
        },
        photos: {
          orderBy: { uploaded_at: 'desc' }
        }
      },
      orderBy: { visit_time: 'desc' }
    });

    return res.status(200).json({
      success: true,
      data: recoveryVisits
    });
  } catch (error) {
    console.error('Get recovery visits error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Replace a recovery visit photo (Super Admin only)
const replaceRecoveryVisitPhoto = async (req, res) => {
  const { photo_id } = req.params;

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  try {
    const existing = await prisma.recoveryVisitPhoto.findUnique({
      where: { id: parseInt(photo_id) }
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Photo not found' });
    }

    const updated = await prisma.recoveryVisitPhoto.update({
      where: { id: parseInt(photo_id) },
      data: {
        file_url: req.file.url,
        uploaded_at: new Date()
      },
      include: {
        recovery_visit: {
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
    if (updated.recovery_visit.order.verification) {
      await prisma.verificationEditHistory.create({
        data: {
          verification_id: updated.recovery_visit.order.verification.id,
          entity_type: 'recovery_visit_photo',
          entity_id: updated.id,
          field_name: 'file_url',
          old_value: existing.file_url,
          new_value: updated.file_url,
          edited_by_id: req.user.id,
          edited_by_name: req.user.full_name,
          edited_at: new Date()
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Recovery visit photo replaced successfully',
      data: { photo: updated }
    });
  } catch (error) {
    console.error('Replace recovery visit photo error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

module.exports = {
  getAllRecoveryOfficers,
  getRecoveryOfficerStats,
  getRecoveryCustomers,
  getCollectionStats,
  getDueOverdueInstallments,
  submitCollections,
  generateInstallmentOtp,
  submitInstallment,
  logRecoveryVisit,
  getOrderRecoveryVisits,
  replaceRecoveryVisitPhoto
};