const prisma = require('../../lib/prisma');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const {
  sendOTP,
  sendInstallmentPaymentReceipt,
  sendPartialInstallmentPaymentReceipt,
  sendNextInstallmentReminder,
  sendPtpConfirmation,
  sendToMany,
  getCompanyNotifyPhones
} = require('../services/watiService');
const { logAction } = require('../utils/auditLogger');
const { getNormalizedLedger, normalizeLedger } = require('../utils/ledgerUtils');
const { createOfficerTransaction } = require('../utils/officerTransactionUtils');
const { updateRecoveryRanking } = require('../services/recoveryRankingService');
const { notifyAdmins, notifyOutlet, notifyUser } = require('../utils/notificationUtils');

const now = () => new Date();

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
            grantors: true,
          },
        },
        delivery: true,
        installment_ledger: true,
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
      const installmentLedgerModel = order.installment_ledger || null;
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
            grantors: order.verification?.grantors || [],
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
        recovery_assigned_at: order.recovery_assigned_at,

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


// ── Branch-wide Payment (any officer, any branch customer) ─────────────────
// Standalone feature, deliberately separate from getRecoveryCustomers /
// submitInstallment: lists every delivered order in the OFFICER'S OWN
// outlet/branch (not just orders assigned to them), so a customer who isn't
// this officer's assigned customer can still pay through them if they want to.
const getBranchCustomers = async (req, res) => {
  const officerId = req.user.id;

  try {
    const officer = await prisma.user.findUnique({
      where: { id: officerId },
      select: { outlet_id: true },
    });

    if (!officer?.outlet_id) {
      return res.status(400).json({ success: false, error: 'Officer is not assigned to any branch/outlet' });
    }

    const orders = await prisma.order.findMany({
      where: {
        is_delivered: true,
        // Everyone in the officer's own branch, PLUS any order assigned to
        // this officer even if its outlet_id doesn't line up (assignment
        // should never hide a customer the officer is responsible for).
        OR: [
          { outlet_id: officer.outlet_id },
          { recovery_officer_id: officerId },
        ],
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
            grantors: true,
          },
        },
        delivery: true,
        installment_ledger: true,
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
      const installmentLedgerModel = order.installment_ledger || null;
      const profilePhoto = order.verification?.documents?.[0]?.file_url || null;

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
            grantors: order.verification?.grantors || [],
          },
          orders: [],
        });
      }

      const group = customerMap.get(key);

      const isDelivered = order.is_delivered || delivery?.status === 'completed';
      const deliveryDate = isDelivered ? (delivery?.end_time || order.updated_at) : null;

      const imeiSerial = cashInHand?.imei_serial || delivery?.product_imei || order.imei_serial || null;
      const invInfo = imeiSerial ? inventoryMap.get(imeiSerial) : null;

      const productName = invInfo?.product_name || cashInHand?.product_name || order.product_name || null;
      const colorVariant = invInfo?.color_variant || cashInHand?.color_variant || null;

      let selectedPlan = delivery?.selected_plan || null;
      if (typeof selectedPlan === 'string') {
        try { selectedPlan = JSON.parse(selectedPlan); } catch { selectedPlan = null; }
      }

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
        is_assigned_to_me: order.recovery_officer_id === officerId,

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
    console.error('getBranchCustomers error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Lightweight payment collection for the branch-wide flow — no photos, no
// location. Enforces that the officer and the order belong to the same
// outlet/branch (the one restriction this flow explicitly requires).
const submitBranchPayment = async (req, res) => {
  const { order_id, month_number, amount, payment_method, feedback, alternate_number } = req.body;
  const officerId = req.user?.id;

  try {
    const officer = await prisma.user.findUnique({
      where: { id: officerId },
      select: { outlet_id: true },
    });

    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: { include: { purchaser: true } },
        installment_ledger: true,
        delivery: true,
        cash_in_hand: { orderBy: { created_at: 'desc' }, take: 1 }
      }
    });

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (!officer?.outlet_id || order.outlet_id !== officer.outlet_id) {
      return res.status(403).json({ success: false, message: 'This customer belongs to a different branch' });
    }

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

    if (totalPaid > dueAmount + 1) {
      return res.status(400).json({ success: false, message: `Payment exceeds due amount. Remaining is ${dueAmount - existingPaid}` });
    }

    const imeiSerial = order.cash_in_hand?.[0]?.imei_serial || order.delivery?.product_imei || order.imei_serial;
    const finalProductName = order.cash_in_hand?.[0]?.product_name || order.product_name;

    await prisma.$transaction(async (tx) => {
      rows[rowIndex].paid_amount = totalPaid;
      rows[rowIndex].paid_at = now();
      rows[rowIndex].payment_method = payment_method;
      rows[rowIndex].feedback = feedback || 'Branch payment';
      rows[rowIndex].collected_by = officerId;
      rows[rowIndex].collection_source = 'recovery_officer';

      if (totalPaid >= dueAmount) {
        rows[rowIndex].status = 'paid';
      } else if (totalPaid > 0) {
        rows[rowIndex].status = 'partial';
      } else {
        rows[rowIndex].status = 'pending';
      }

      await tx.installmentLedger.update({
        where: { id: ledger.id },
        data: {
          ledger_rows: rows,
          updated_at: now()
        }
      });

      const isCash = ['cash', 'recovery_cash', 'recovery cash'].includes(payment_method?.toLowerCase());
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
            cash_type: 'Branch payment',
            submitted_amount: 0,
            created_at: now(),
            updated_at: now()
          }
        });

        await createOfficerTransaction({
          officer_id: officerId,
          type: 'credit',
          amount: payingNow,
          status: 'pending',
          description: `Branch payment collected from ${order.verification?.purchaser?.name || order.customer_name}`,
          payment_method: payment_method,
          order_ref: order.order_ref
        }, tx);
      }

      // No photos/location for this flow — log a lightweight visit record.
      await tx.recoveryVisit.create({
        data: {
          order_id: parseInt(order_id),
          officer_id: officerId,
          visit_time: now(),
          customer_feedback: feedback || 'Branch payment (no assigned visit)',
          payment_collected: true,
          amount_collected: payingNow,
          created_at: now()
        }
      });
    });

    // Wati Notifications — same pattern as submitInstallment
    const customerName = order.verification?.purchaser?.name || order.customer_name;
    const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
    const altPhone = (alternate_number && String(alternate_number).trim())
      || order.verification?.purchaser?.alternate_contact
      || order.alternate_contact;
    const notifyPhones = [phone, altPhone, req.user?.phone, ...getCompanyNotifyPhones()];

    if (totalPaid >= dueAmount) {
      sendToMany(notifyPhones, (p) => sendInstallmentPaymentReceipt(p, {
        customerName,
        amount: payingNow,
        productName: finalProductName,
        orderRef: order.order_ref,
        date: new Date().toLocaleDateString('en-PK')
      })).catch(err => console.error('Wati Receipt Error:', err));
    } else {
      sendToMany(notifyPhones, (p) => sendPartialInstallmentPaymentReceipt(p, {
        customerName,
        paidAmount: payingNow,
        remainingAmount: Math.max(0, dueAmount - totalPaid),
        productName: finalProductName,
        orderRef: order.order_ref,
        dueDate: new Date(rows[rowIndex].due_date || rows[rowIndex].dueDate).toLocaleDateString('en-PK')
      })).catch(err => console.error('Wati Partial Receipt Error:', err));
    }

    // ── Transaction notification — Admin/Super Admin + the officer's outlet ──
    const io = req.app.get('io');
    const notifyTitle = 'Recovery Payment Collected (Branch)';
    const notifyMsg = `${req.user?.full_name || 'Recovery Officer'} collected PKR ${payingNow} from ${customerName} (Order #${order.order_ref})`;
    notifyAdmins(notifyTitle, notifyMsg, 'payment_collected', order.id, io)
      .catch(err => console.error('notifyAdmins error:', err));
    if (order.outlet_id) {
      notifyOutlet(order.outlet_id, notifyTitle, notifyMsg, 'payment_collected', order.id, io)
        .catch(err => console.error('notifyOutlet error:', err));
    }

    return res.json({ success: true, message: 'Payment processed successfully' });
  } catch (error) {
    console.error('submitBranchPayment error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Cash In Hand (Recovery Officer day book) ────────────────────────────────
// `cashInHand` is always the officer's current unsubmitted running balance
// (never date-bound). When `filter`/`startDate`/`endDate` query params are
// given, `recentCollections` is the full, date-filtered cash log; without
// them it falls back to the last 10 entries (legacy dashboard widget call).
const getCollectionStats = async (req, res) => {
  const officerId = req.user.id;
  const { filter, startDate, endDate } = req.query;

  try {
    const pendingEntries = await prisma.cashInHand.findMany({
      where: {
        officer_id: officerId,
        status: 'pending',
      }
    });

    const totalCashInHand = pendingEntries.reduce((sum, entry) => {
      return sum + (entry.amount - (entry.submitted_amount || 0));
    }, 0);

    let start, end;
    if (filter) {
      const nowDt = new Date();
      if (filter === 'today') {
        start = new Date(nowDt); start.setHours(0, 0, 0, 0);
        end = new Date(nowDt); end.setHours(23, 59, 59, 999);
      } else if (filter === 'month') {
        start = new Date(nowDt.getFullYear(), nowDt.getMonth(), 1, 0, 0, 0, 0);
        end = new Date(nowDt.getFullYear(), nowDt.getMonth() + 1, 0, 23, 59, 59, 999);
      } else if (filter === 'custom' && startDate && endDate) {
        start = new Date(startDate); start.setHours(0, 0, 0, 0);
        end = new Date(endDate); end.setHours(23, 59, 59, 999);
      }
    }

    const collections = await prisma.cashInHand.findMany({
      where: {
        officer_id: officerId,
        ...(start && end ? { created_at: { gte: start, lte: end } } : {})
      },
      orderBy: { created_at: 'desc' },
      take: filter ? undefined : 10,
      include: { order: { select: { order_ref: true } } }
    });

    const totalCollected = collections.reduce((s, c) => s + c.amount, 0);
    const totalSubmitted = collections.reduce((s, c) => s + (c.submitted_amount || 0), 0);

    return res.json({
      success: true,
      data: {
        filter: filter || null,
        dateRange: start && end ? { start, end } : null,
        cashInHand: totalCashInHand,
        totalCollected,
        totalSubmitted,
        count: collections.length,
        recentCollections: collections.map(c => ({
          id: c.id,
          orderId: c.order_id,
          orderRef: c.order?.order_ref || null,
          customerName: c.customer_name,
          productName: c.product_name,
          amount: c.amount,
          submittedAmount: c.submitted_amount || 0,
          remainingAmount: c.amount - (c.submitted_amount || 0),
          status: c.status,
          paymentMethod: c.payment_method,
          cashType: c.cash_type,
          createdAt: c.created_at,
          updatedAt: c.updated_at
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
  const { order_id, latitude, longitude, customer_feedback, visit_notes, promised_date } = req.body;
  const officerId = req.user?.id || 24;

  // Extract uploaded files
  const visitPhotos = req.files?.['visit_photos'] || [];
  const profilePhotos = req.files?.['profile_photo'] || [];

  // Validate photo counts
  if (visitPhotos.length > 5) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Maximum 5 visit photos allowed' }
    });
  }
  if (profilePhotos.length > 5) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Maximum 5 customer photos allowed' }
    });
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: { include: { purchaser: true, documents: { where: { document_type: 'photo', person_type: 'purchaser' }, orderBy: { uploaded_at: 'desc' }, take: 1 } } },
        installment_ledger: true,
        cash_in_hand: { orderBy: { created_at: 'desc' }, take: 1 }
      }
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const parsedPromisedDate = promised_date ? new Date(promised_date) : null;

    // Use transaction for visit and photos
    const result = await prisma.$transaction(async (tx) => {
      const visit = await tx.recoveryVisit.create({
        data: {
          order_id: parseInt(order_id),
          officer_id: officerId,
          latitude: latitude ? parseFloat(latitude) : null,
          longitude: longitude ? parseFloat(longitude) : null,
          visit_time: now(),
          customer_feedback,
          visit_notes,
          payment_collected: false,
          amount_collected: null,
          promised_date: parsedPromisedDate,
          created_at: now()   // ✅ explicit created_at
        }
      });

      // Prepare photo records for batch insert
      const photoRecords = [];

      // Add profile photo(s) (from upload, fallback to verification photo)
      if (profilePhotos.length > 0) {
        profilePhotos.forEach((file) => {
          photoRecords.push({
            recovery_visit_id: visit.id,
            file_url: file.url,
            photo_type: 'profile',
            uploaded_at: now()   // ✅ explicit uploaded_at
          });
        });
      } else if (order.verification?.documents?.[0]?.file_url) {
        photoRecords.push({
          recovery_visit_id: visit.id,
          file_url: order.verification.documents[0].file_url,
          photo_type: 'profile',
          uploaded_at: now()   // ✅ explicit uploaded_at
        });
      }

      // Add visit photos
      visitPhotos.forEach((file) => {
        photoRecords.push({
          recovery_visit_id: visit.id,
          file_url: file.url,
          photo_type: 'visit_location',
          uploaded_at: now()   // ✅ explicit uploaded_at
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

    // Officer set a Promise to Pay during this (no-payment) visit — notify
    // customer + alternate + officer + company so the promise is actually
    // visible to the customer, not just recorded in the app.
    if (parsedPromisedDate) {
      const customerName = order.verification?.purchaser?.name || order.customer_name;
      const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
      const altPhone = order.verification?.purchaser?.alternate_contact || order.alternate_contact;
      const notifyPhones = [phone, altPhone, req.user?.phone, ...getCompanyNotifyPhones()];
      const finalProductName = order.cash_in_hand?.[0]?.product_name || order.product_name;

      let amountDue = 0;
      try {
        const rawRows = order.installment_ledger?.ledger_rows;
        if (rawRows) {
          const normalized = getNormalizedLedger(Array.isArray(rawRows) ? rawRows : JSON.parse(rawRows));
          const pendingRow = normalized.installment_ledger.find(r => (r.status || '').toLowerCase() !== 'paid');
          amountDue = pendingRow?.remainingAmount ?? pendingRow?.dueAmount ?? 0;
        }
      } catch (e) { /* amountDue stays 0 if ledger can't be parsed */ }

      sendToMany(notifyPhones, (p) => sendPtpConfirmation(p, {
        customerName,
        productName: finalProductName,
        orderRef: order.order_ref,
        promisedDate: parsedPromisedDate.toLocaleDateString('en-PK'),
        amountDue,
      })).catch(err => console.error('Wati PTP Confirmation Error:', err));
    }

    return res.json({ success: true, message: 'Recovery visit logged successfully with photos', visit: result });
  } catch (error) {
    console.error('logRecoveryVisit error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

const submitInstallment = async (req, res) => {
  const {
    order_id, month_number, amount, payment_method, feedback, fuelCharges,
    latitude, longitude, visit_notes, alternate_number, promised_date
  } = req.body;
  const officerId = req.user?.id;

  // Extract uploaded files
  const visitPhotos = req.files?.['visit_photos'] || [];
  const profilePhotos = req.files?.['profile_photo'] || [];

  // Validate photo counts
  if (visitPhotos.length > 5) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Maximum 5 visit photos allowed' }
    });
  }
  if (profilePhotos.length > 5) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Maximum 5 customer photos allowed' }
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
    const parsedPromisedDate = promised_date ? new Date(promised_date) : null;

    // DB Transaction
    await prisma.$transaction(async (tx) => {
      rows[rowIndex].paid_amount = totalPaid;
      rows[rowIndex].paid_at = now();
      rows[rowIndex].payment_method = payment_method;
      rows[rowIndex].feedback = feedback;
      rows[rowIndex].collected_by = officerId;
      rows[rowIndex].collection_source = 'recovery_officer';
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
        data: {
          ledger_rows: rows,
          updated_at: now()   // ✅ explicit updated_at
        }
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
            created_at: now(),   // ✅ explicit created_at
            updated_at: now()    // ✅ explicit updated_at
          }
        });

        // Create Officer Transaction for this credit (helper handles its own timestamps)
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
          visit_time: now(),
          customer_feedback: feedback,
          visit_notes: visit_notes,
          payment_collected: true,
          amount_collected: payingNow,
          promised_date: parsedPromisedDate,
          created_at: now()   // ✅ explicit created_at
        }
      });

      // Prepare photo records for batch insert
      const photoRecords = [];

      profilePhotos.forEach((file) => {
        photoRecords.push({
          recovery_visit_id: visit.id,
          file_url: file.url,
          photo_type: 'profile',
          uploaded_at: now()   // ✅ explicit uploaded_at
        });
      });

      // Add visit photos
      visitPhotos.forEach((file, index) => {
        photoRecords.push({
          recovery_visit_id: visit.id,
          file_url: file.url,
          photo_type: 'visit_location',
          uploaded_at: now()   // ✅ explicit uploaded_at
        });
      });

      // Batch insert all photos
      if (photoRecords.length > 0) {
        await tx.recoveryVisitPhoto.createMany({
          data: photoRecords
        });
      }
    });

    // Wati Notifications — customer + alternate number (officer-entered or on file) + the officer + company copy
    const customerName = order.verification?.purchaser?.name || order.customer_name;
    const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
    const altPhone = (alternate_number && String(alternate_number).trim())
      || order.verification?.purchaser?.alternate_contact
      || order.alternate_contact;
    const notifyPhones = [phone, altPhone, req.user?.phone, ...getCompanyNotifyPhones()];

    if (totalPaid >= dueAmount) {
      sendToMany(notifyPhones, (p) => sendInstallmentPaymentReceipt(p, {
        customerName,
        amount: payingNow,
        productName: finalProductName,
        orderRef: order.order_ref,
        date: new Date().toLocaleDateString('en-PK')
      })).catch(err => console.error('Wati Receipt Error:', err));
    } else {
      sendToMany(notifyPhones, (p) => sendPartialInstallmentPaymentReceipt(p, {
        customerName,
        paidAmount: payingNow,
        remainingAmount: Math.max(0, dueAmount - totalPaid),
        productName: finalProductName,
        orderRef: order.order_ref,
        dueDate: new Date(rows[rowIndex].due_date || rows[rowIndex].dueDate).toLocaleDateString('en-PK')
      })).catch(err => console.error('Wati Partial Receipt Error:', err));
    }

    const nextRow = rows[rowIndex + 1];
    if (nextRow) {
      sendToMany(notifyPhones, (p) => sendNextInstallmentReminder(p, {
        customerName,
        productName: finalProductName,
        monthlyAmount: nextRow.amount || nextRow.dueAmount,
        dueDate: new Date(nextRow.due_date || nextRow.dueDate).toLocaleDateString('en-PK'),
        ledgerUrl: ledger.token ? `${ledger.token}` : null
      })).catch(err => console.error('Wati Reminder Error:', err));
    }

    // Officer set a new Promise to Pay during this visit — send a dedicated
    // confirmation so the customer actually sees the promised date (the
    // receipt/reminder templates above don't carry it).
    if (parsedPromisedDate) {
      sendToMany(notifyPhones, (p) => sendPtpConfirmation(p, {
        customerName,
        productName: finalProductName,
        orderRef: order.order_ref,
        promisedDate: parsedPromisedDate.toLocaleDateString('en-PK'),
        amountDue: Math.max(0, dueAmount - totalPaid),
      })).catch(err => console.error('Wati PTP Confirmation Error:', err));
    }

    // await logAction(...) commented out

    // ── Transaction notification — Admin/Super Admin + the officer's outlet ──
    const io = req.app.get('io');
    const notifyTitle = 'Recovery Payment Collected';
    const notifyMsg = `${req.user?.full_name || 'Recovery Officer'} collected PKR ${payingNow} from ${customerName} (Order #${order.order_ref})`;
    notifyAdmins(notifyTitle, notifyMsg, 'payment_collected', order.id, io)
      .catch(err => console.error('notifyAdmins error:', err));
    if (order.outlet_id) {
      notifyOutlet(order.outlet_id, notifyTitle, notifyMsg, 'payment_collected', order.id, io)
        .catch(err => console.error('notifyOutlet error:', err));
    }

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

// ── Full Profile — everything about one customer's order in one place ──────
// Contact + guarantor basics (already used elsewhere) + full ledger +
// verification location + a merged, dated timeline of visits/feedback/PTPs.
// NOTE: delivery has no lat/long anywhere in the schema — this endpoint
// cannot return a delivery location because it was never captured.
const getCustomerFullProfile = async (req, res) => {
  const { order_id } = req.params;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: {
          include: {
            purchaser: true,
            grantors: true,
            locations: true, // LocationTracking (live GPS pings during verification)
            verification_locations: true, // richer, labeled location captures
          },
        },
        delivery: true,
        installment_ledger: true,
        paytrigger_devices: true,
      },
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const purchaser = order.verification?.purchaser || null;
    const normalized = getNormalizedLedger(order.installment_ledger?.ledger_rows);

    // ── Timeline: visits (feedback + location + photos) + PTP history ──────
    const visits = await prisma.recoveryVisit.findMany({
      where: { order_id: order.id },
      include: { photos: { orderBy: { uploaded_at: 'desc' } } },
      orderBy: { visit_time: 'desc' },
    });

    const timeline = visits.map(v => ({
      type: 'visit',
      date: v.visit_time,
      feedback: v.customer_feedback,
      notes: v.visit_notes,
      latitude: v.latitude,
      longitude: v.longitude,
      payment_collected: v.payment_collected,
      amount_collected: v.amount_collected,
      fuel_charges: v.fuel_charges,
      photos: v.photos.map(p => p.file_url),
    }));

    const device = order.paytrigger_devices?.[0] || null;
    if (device?.ptp_history && Array.isArray(device.ptp_history)) {
      for (const entry of device.ptp_history) {
        timeline.push({
          type: 'ptp',
          date: entry.date,
          promised_date: entry.promised_date,
          status: entry.status,
          // Only present for PTPs set after location capture was added —
          // older entries fall back to null (matching visit, if any, still
          // carries its own location separately).
          latitude: entry.latitude ?? null,
          longitude: entry.longitude ?? null,
        });
      }
    }

    // ── Payments collected outside a recovery visit (outlet counter, online
    // SmartPay QR) — these never create a recoveryVisit row, so without this
    // they'd be invisible here. Recovery-officer payments are skipped since
    // they already appear above via their matching 'visit' entry. Only rows
    // tagged with collection_source (added after this fix) are covered —
    // older untagged rows can't be reliably attributed after the fact.
    let rawLedgerRows = order.installment_ledger?.ledger_rows;
    if (typeof rawLedgerRows === 'string') {
      try { rawLedgerRows = JSON.parse(rawLedgerRows); } catch { rawLedgerRows = []; }
    }
    const outsidePaymentRows = (Array.isArray(rawLedgerRows) ? rawLedgerRows : [])
      .filter(r => parseFloat(r.paid_amount || 0) > 0 && ['outlet', 'online'].includes(r.collection_source));

    const collectorIds = [...new Set(
      outsidePaymentRows.filter(r => r.collection_source === 'outlet' && r.collected_by != null).map(r => Number(r.collected_by))
    )];
    const outletIds = [...new Set(
      outsidePaymentRows.filter(r => r.collection_source === 'outlet' && r.collected_by_outlet_id != null).map(r => Number(r.collected_by_outlet_id))
    )];
    const [collectors, collectorOutlets] = await Promise.all([
      collectorIds.length > 0
        ? prisma.user.findMany({ where: { id: { in: collectorIds } }, select: { id: true, full_name: true } })
        : Promise.resolve([]),
      outletIds.length > 0
        ? prisma.outlet.findMany({ where: { id: { in: outletIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
    ]);
    const collectorNameMap = collectors.reduce((acc, u) => { acc[u.id] = u.full_name; return acc; }, {});
    const outletNameMap = collectorOutlets.reduce((acc, o) => { acc[o.id] = o.name; return acc; }, {});

    for (const row of outsidePaymentRows) {
      timeline.push({
        type: 'payment',
        date: row.paid_at,
        source: row.collection_source,
        amount_collected: parseFloat(row.paid_amount || 0),
        payment_method: row.payment_method || null,
        collected_by_name: row.collection_source === 'outlet'
          ? (collectorNameMap[Number(row.collected_by)] || null)
          : null,
        collected_by_outlet_name: row.collection_source === 'outlet'
          ? (outletNameMap[Number(row.collected_by_outlet_id)] || null)
          : null,
        transaction_id: row.transaction_id || null,
      });
    }

    timeline.sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.json({
      success: true,
      data: {
        customer: {
          name: purchaser?.name || order.customer_name,
          father_husband_name: purchaser?.father_husband_name || null,
          cnic_number: purchaser?.cnic_number || null,
          whatsapp_number: order.whatsapp_number,
          telephone_number: purchaser?.telephone_number || order.whatsapp_number,
          present_address: purchaser?.present_address || null,
          permanent_address: purchaser?.permanent_address || null,
          city: order.city,
          area: order.area,
        },
        guarantors: (order.verification?.grantors || []).map(g => ({
          name: g.name,
          relation: g.relationship,
          telephone_number: g.telephone_number,
          address: g.present_address,
          nearest_location: g.nearest_location,
        })),
        ledger: normalized,
        verification_location: [
          ...(order.verification?.locations || []).map(l => ({
            source: 'live_tracking',
            label: l.label,
            latitude: l.latitude,
            longitude: l.longitude,
            timestamp: l.timestamp,
          })),
          ...(order.verification?.verification_locations || []).map(l => ({
            source: 'verification_capture',
            label: l.label,
            type: l.location_type,
            latitude: l.latitude,
            longitude: l.longitude,
            address: l.address,
            timestamp: l.created_at,
          })),
        ],
        delivery_location: null, // not captured anywhere in the system today
        device: device ? {
          imei: device.imei,
          ptp_status: device.ptp_status,
          promised_date: device.promised_date,
          lock_status: device.lock_status,
        } : null,
        timeline,
      },
    });
  } catch (error) {
    console.error('getCustomerFullProfile error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
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
        uploaded_at: now()   // ✅ explicit uploaded_at
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

    // Log to edit history with explicit edited_at
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
          edited_at: now()   // ✅ explicit edited_at
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

const getRecoveryDashboardStats = async (req, res) => {
  try {
    const { filter = 'today', startDate, endDate } = req.query;
    const userId = req.user?.id;

    // Fetch officer info from DB (for bike_km_range, working_hours)
    const officerInfo = await prisma.user.findUnique({
      where: { id: userId },
      select: { bike_km_range: true, working_hours_start: true, working_hours_end: true }
    });

    // Trigger async ranking update
    updateRecoveryRanking(userId, 'today').catch(err => console.error('Auto-ranking update error:', err));
    updateRecoveryRanking(userId, 'month').catch(err => console.error('Auto-ranking update error:', err));

    const nowDt = new Date();
    let start, end;

    if (filter === 'today') {
      start = new Date(nowDt); start.setHours(0, 0, 0, 0);
      end = new Date(nowDt); end.setHours(23, 59, 59, 999);
    } else if (filter === 'month') {
      start = new Date(nowDt.getFullYear(), nowDt.getMonth(), 1, 0, 0, 0, 0);
      end = new Date(nowDt.getFullYear(), nowDt.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (filter === 'custom' && startDate && endDate) {
      start = new Date(startDate); start.setHours(0, 0, 0, 0);
      end = new Date(endDate); end.setHours(23, 59, 59, 999);
    } else {
      start = new Date(nowDt); start.setHours(0, 0, 0, 0);
      end = new Date(nowDt); end.setHours(23, 59, 59, 999);
    }

    const dateFilter = { gte: start, lte: end };

    const baseWhere = {
      updated_at: dateFilter,
      recovery_officer_id: userId
    };

    // Status counts
    const statusGroups = await prisma.order.groupBy({
      by: ['status'],
      where: baseWhere,
      _count: { id: true },
    });

    const statusCounts = statusGroups.reduce((acc, item) => {
      acc[item.status] = item._count.id;
      return acc;
    }, {});

    const totalOrders = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const newCount = statusCounts['new'] || 0;
    const pendingCount = statusCounts['pending'] || 0;
    const inProgressCount = statusCounts['in_progress'] || 0;
    const cancelledCount = statusCounts['cancelled'] || 0;
    const completedCount = statusCounts['completed'] || 0;
    const deliveredCount = statusCounts['delivered'] || 0;
    const expiredCount = statusCounts['expired'] || 0;
    const postponedCount = statusCounts['postponed'] || 0;
    const rejectedCount = statusCounts['rejected'] || 0;

    // Recovery-specific metrics
    const cashInHandSum = await prisma.cashInHand.aggregate({
      where: { officer_id: userId, status: 'pending' },
      _sum: { amount: true, submitted_amount: true }
    });

    const totalCashInHand = (cashInHandSum._sum.amount || 0) - (cashInHandSum._sum.submitted_amount || 0);

    const collectedAmountSum = await prisma.recoveryVisit.aggregate({
      where: { officer_id: userId, payment_collected: true, visit_time: dateFilter },
      _sum: { amount_collected: true }
    });

    const topVisitDeadlineOrders = await prisma.order.findMany({
      where: {
        recovery_officer_id: userId,
        status: { in: ['pending', 'in_progress', 'delivered'] } // For recovery, delivered orders have installments
      },
      orderBy: { updated_at: 'asc' },
      take: 5
    });

    // Yesterday for increment
    const yesterdayStart = new Date(start); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayEnd = new Date(end); yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);

    const yesterdayStatusGroups = await prisma.order.groupBy({
      by: ['status'],
      where: { ...baseWhere, updated_at: { gte: yesterdayStart, lte: yesterdayEnd } },
      _count: { id: true },
    });

    const yesterdayCounts = yesterdayStatusGroups.reduce((acc, item) => {
      acc[item.status] = item._count.id;
      return acc;
    }, {});

    const calcIncrement = (curr, prev) => {
      if (!prev || prev === 0) return curr > 0 ? 100 : 0;
      return Math.round(((curr - prev) / prev) * 100);
    };

    const todayIncrement = {
      total: calcIncrement(totalOrders, Object.values(yesterdayCounts).reduce((a, b) => a + b, 0)),
      new: calcIncrement(newCount, yesterdayCounts['new']),
      pending: calcIncrement(pendingCount, yesterdayCounts['pending']),
      delivered: calcIncrement(deliveredCount, yesterdayCounts['delivered']),
      cancelled: calcIncrement(cancelledCount, yesterdayCounts['cancelled']),
      expired: calcIncrement(expiredCount, yesterdayCounts['expired']),
      postponed: calcIncrement(postponedCount, yesterdayCounts['postponed']),
      rejected: calcIncrement(rejectedCount, yesterdayCounts['rejected']),
    };

    // Visit Activity Metrics
    const visits = await prisma.recoveryVisit.findMany({
      where: { officer_id: userId, visit_time: dateFilter },
      select: { order_id: true, payment_collected: true }
    });

    const visitStats = {
      totalVisits: visits.length,
      uniqueCustomersVisited: new Set(visits.map(v => v.order_id)).size,
      recoverySuccessCount: new Set(visits.filter(v => v.payment_collected).map(v => v.order_id)).size
    };

    // Rankings
    const rankingPeriod = filter === 'custom' ? 'month' : filter;

    const recoveryOfficers = await prisma.user.findMany({
      where: {
        role: {
          name: { contains: 'Recovery' }
        }
      },
      select: { id: true, full_name: true, username: true, image: true, outlet: { select: { name: true } } }
    });

    const rankings = await prisma.recoveryRanking.findMany({
      where: {
        period: rankingPeriod,
        month: rankingPeriod === 'month' ? nowDt.getMonth() + 1 : 0,
        year: rankingPeriod === 'month' ? nowDt.getFullYear() : 0,
      }
    });

    const rankingMap = rankings.reduce((acc, r) => { acc[r.officer_id] = r; return acc; }, {});

    let officerRanking = recoveryOfficers.map(officer => {
      const rankRecord = rankingMap[officer.id];
      const score = rankRecord ? rankRecord.score : 0;
      let league = 'Bronze';
      if (score >= 1500) league = 'Gold';
      else if (score >= 1000) league = 'Silver';

      return {
        userId: officer.id,
        name: officer.full_name,
        username: officer.username,
        image: officer.image,
        outletName: officer.outlet?.name || 'Main Outlet',
        uniqueCustomers: rankRecord ? rankRecord.unique_customers : 0,
        delivered: rankRecord ? rankRecord.delivered_customers : 0,
        completed: rankRecord ? rankRecord.completed_customers : 0,
        cancelled: rankRecord ? rankRecord.cancelled_customers : 0,
        expired: rankRecord ? rankRecord.expired_customers : 0,
        totalSales: rankRecord ? rankRecord.total_sales : 0, // This represents collected amount for recovery
        score: score,
        trend: rankRecord ? rankRecord.trend : 0,
        league: league
      };
    });

    officerRanking.sort((a, b) => b.score - a.score);
    officerRanking = officerRanking.map((r, index) => ({ ...r, rank: index + 1 }));

    // Today's Installments
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const activeRecoveryOrders = await prisma.order.findMany({
      where: {
        recovery_officer_id: userId,
        status: { in: ['pending', 'in_progress', 'delivered'] },
        is_delivered: true
      },
      include: {
        installment_ledger: true,
        verification: {
          include: { purchaser: true }
        },
        delivery: true,
        cash_in_hand: { orderBy: { created_at: 'desc' }, take: 1 }
      }
    });

    const officerOrderIds = activeRecoveryOrders.map(o => o.id);
    const ptpDevices = await prisma.payTriggerDevice.findMany({
      where: {
        order_id: { in: officerOrderIds },
        ptp_status: { in: ['active', 'broken', 'fulfilled'] }
      },
      select: { order_id: true, ptp_status: true }
    });

    const ptpStats = { active: 0, broken: 0, fulfilled: 0 };
    for (const d of ptpDevices) {
      if (ptpStats[d.ptp_status] !== undefined) {
        ptpStats[d.ptp_status]++;
      }
    }


    // ── Resolve the ACTUAL delivered product by IMEI, not the suggested
    // product_name stored on the order at creation time ─────────────────
    const activeOrdersImeis = activeRecoveryOrders
      .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
      .filter(Boolean);

    const activeOrdersInventories = await prisma.outletInventory.findMany({
      where: { imei_serial: { in: activeOrdersImeis } },
      select: { imei_serial: true, product_name: true }
    });

    const activeOrdersInventoryMap = new Map();
    for (const inv of activeOrdersInventories) {
      if (inv.imei_serial) activeOrdersInventoryMap.set(inv.imei_serial, inv);
    }

    const getDeliveredProductName = (order) => {
      const imeiSerial = order.cash_in_hand?.[0]?.imei_serial || order.delivery?.product_imei || order.imei_serial;
      const invInfo = imeiSerial ? activeOrdersInventoryMap.get(imeiSerial) : null;
      return invInfo?.product_name || order.cash_in_hand?.[0]?.product_name || order.product_name || '';
    };

    let todayInstallmentsCount = 0;
    let todayInstallmentsAmount = 0;
    const todayInstallmentsAccounts = [];

    try {
      activeRecoveryOrders.forEach(order => {
        if (!order.installment_ledger?.ledger_rows) return;

        // ledger_rows might be a JSON string — parse it if needed
        let rawRows = order.installment_ledger.ledger_rows;
        if (typeof rawRows === 'string') {
          rawRows = JSON.parse(rawRows);
        }
        if (!Array.isArray(rawRows)) return;

        const normalized = getNormalizedLedger(rawRows);
        const rows = normalized.rows;

        rows.forEach(row => {
          if (row.month === 0 || row.status === 'paid') return;

          const dueDate = new Date(row.due_date || row.dueDate);
          if (isNaN(dueDate.getTime())) return; // skip invalid dates
          dueDate.setHours(0, 0, 0, 0);

          if (dueDate.getTime() === today.getTime()) {
            todayInstallmentsCount++;
            todayInstallmentsAmount += (row.remainingAmount || 0);

            todayInstallmentsAccounts.push({
              orderId: order.id,
              orderRef: order.order_ref || '',
              customerName: order.verification?.purchaser?.name || order.customer_name || '',
              cnicNumber: order.verification?.purchaser?.cnic_number || null,
              itemName: getDeliveredProductName(order),
              installmentAmount: row.dueAmount || 0,
              remainingBalance: row.remainingAmount || 0,
              totalRemaining: normalized.summary?.totalInstallmentRemaining || 0,
              whatsappNumber: order.whatsapp_number || order.verification?.purchaser?.telephone_number || '',
              address: order.address || order.verification?.purchaser?.present_address || '',
              city: order.city || '',
              area: order.area || order.verification?.purchaser?.present_area || ''
            });
          }
        });
      });
    } catch (installmentError) {
      console.error('[Today Installments] Error calculating today installments:', installmentError.message);
      console.error('[Today Installments] Stack:', installmentError.stack);
    }

    // ── Overdue / Defaulter / Blacklist ──────────────────────────────────
    const threeMonthsAgo = new Date(today);
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const regularAccounts = [];
    const overdueAccounts = [];
    const defaulterAccounts = [];
    const blacklistAccounts = [];
    const clearedAccounts = [];

    try {
      activeRecoveryOrders.forEach(order => {
        if (!order.installment_ledger?.ledger_rows) return;

        let rawRows = order.installment_ledger.ledger_rows;
        if (typeof rawRows === 'string') rawRows = JSON.parse(rawRows);
        if (!Array.isArray(rawRows)) return;

        const normalized = getNormalizedLedger(rawRows);
        const installments = normalized.installment_ledger; // already filtered month>0

        const customerName = order.verification?.purchaser?.name || order.customer_name || '';
        const cnicNumber = order.verification?.purchaser?.cnic_number || null;
        const itemName = getDeliveredProductName(order);
        const orderRef = order.order_ref || '';
        const orderId = order.id;

        // ── REGULAR / OVERDUE: unpaid rows whose due date has passed ────
        // 1 missed due date  -> still a "Regular Account" (just late this month)
        // 2+ missed due dates -> escalates to "Overdue" (missed next month too)
        const overdueRows = installments.filter(r => {
          if (r.status === 'paid') return false;
          const d = new Date(r.dueDate);
          return !isNaN(d.getTime()) && d < today;
        });

        if (overdueRows.length === 1) {
          const totalOverdue = overdueRows.reduce((s, r) => s + (r.remainingAmount || 0), 0);
          regularAccounts.push({
            orderId, orderRef, customerName, cnicNumber, itemName,
            overdueMonths: overdueRows.length,
            overdueAmount: totalOverdue,
            totalRemaining: normalized.summary.totalInstallmentRemaining
          });
        } else if (overdueRows.length >= 2) {
          const totalOverdue = overdueRows.reduce((s, r) => s + (r.remainingAmount || 0), 0);
          overdueAccounts.push({
            orderId, orderRef, customerName, cnicNumber, itemName,
            overdueMonths: overdueRows.length,
            overdueAmount: totalOverdue,
            totalRemaining: normalized.summary.totalInstallmentRemaining
          });
        }

        // ── DEFAULTER: ZERO payment in last 3 months ───────────────────
        // Find installments whose due date fell within last 3 months
        const last3Rows = installments.filter(r => {
          const d = new Date(r.dueDate);
          return !isNaN(d.getTime()) && d >= threeMonthsAgo && d < today;
        });

        if (last3Rows.length >= 3) {
          const totalPaidInPeriod = last3Rows.reduce((s, r) => s + (r.paidAmount || 0), 0);
          if (totalPaidInPeriod === 0) {
            defaulterAccounts.push({
              orderId, orderRef, customerName, cnicNumber, itemName,
              missedMonths: last3Rows.length,
              missedAmount: last3Rows.reduce((s, r) => s + (r.dueAmount || 0), 0),
              totalRemaining: normalized.summary.totalInstallmentRemaining
            });
          }
        }

        // ── BLACKLIST: some payment in 3 months but very little ────────
        if (last3Rows.length >= 3) {
          const totalPaidInPeriod = last3Rows.reduce((s, r) => s + (r.paidAmount || 0), 0);
          const totalDueInPeriod = last3Rows.reduce((s, r) => s + (r.dueAmount || 0), 0);
          // Partial payment > 0 but less than 50% of what was due
          if (totalPaidInPeriod > 0 && totalDueInPeriod > 0 &&
            totalPaidInPeriod < totalDueInPeriod * 0.5) {
            blacklistAccounts.push({
              orderId, orderRef, customerName, cnicNumber, itemName,
              paidInPeriod: totalPaidInPeriod,
              dueInPeriod: totalDueInPeriod,
              coveragePercent: Math.round((totalPaidInPeriod / totalDueInPeriod) * 100),
              totalRemaining: normalized.summary.totalInstallmentRemaining
            });
          }
        }

        // ── CLEARED: assigned to this officer, fully paid off, 0 balance ──
        if (normalized.summary.installmentsStarted &&
          normalized.summary.grandTotalDue > 0 &&
          normalized.summary.grandTotalRemaining === 0) {
          clearedAccounts.push({
            orderId, orderRef, customerName, cnicNumber, itemName,
            installmentAmount: 0,
            remainingBalance: 0,
            totalPaid: normalized.summary.grandTotalPaid,
            totalRemaining: 0
          });
        }
      });
    } catch (classifyError) {
      console.error('[Overdue/Defaulter/Blacklist] Error:', classifyError.message);
    }

    // Target Tracking (variables used in response below)
    const monthlyTarget = Number(process.env.RECOVERY_TARGET_AMOUNT || 500000);
    const customerTarget = Number(process.env.RECOVERY_TARGET_CUSTOMERS || 50);
    const achievedAmount = collectedAmountSum._sum.amount_collected || 0;
    const achievedCustomers = statusCounts['completed'] || 0;
    const remainingAmount = Math.max(0, monthlyTarget - achievedAmount);
    const remainingCustomers = Math.max(0, customerTarget - achievedCustomers);

    return res.status(200).json({
      success: true,
      data: {
        filter,
        dateRange: { start, end },
        totalOrders,
        statusCounts: {
          new: newCount,
          pending: pendingCount,
          in_progress: inProgressCount,
          cancelled: cancelledCount,
          completed: completedCount,
          delivered: deliveredCount,
          expired: expiredCount,
          postponed: postponedCount,
          rejected: rejectedCount,
        },
        bikeRange: officerInfo?.bike_km_range || 0,
        workingHours: `${officerInfo?.working_hours_start || '09:00'} - ${officerInfo?.working_hours_end || '18:00'}`,
        cashInHand: totalCashInHand,
        collectedAmount: achievedAmount,
        topVisitDeadlineOrders,
        todayIncrement,
        todayInstallments: {
          count: todayInstallmentsCount,
          totalAmount: todayInstallmentsAmount,
          accounts: todayInstallmentsAccounts
        },
        regular: {
          count: regularAccounts.length,
          accounts: regularAccounts
        },
        overdue: {
          count: overdueAccounts.length,
          accounts: overdueAccounts
        },
        defaulter: {
          count: defaulterAccounts.length,
          accounts: defaulterAccounts
        },
        blacklist: {
          count: blacklistAccounts.length,
          accounts: blacklistAccounts
        },
        cleared: {
          count: clearedAccounts.length,
          accounts: clearedAccounts
        },
        visitStats,
        ptp: ptpStats,
        targetTracking: {
          achievedAmount,
          targetAmount: monthlyTarget,
          remainingAmount,
          achievedCustomers,
          targetCustomers: customerTarget,
          remainingCustomers,
        },
        officerRanking
      },
    });
  } catch (error) {
    console.error('getDashboardStats error:', error);
    console.error('getDashboardStats error message:', error.message);
    console.error('getDashboardStats error stack:', error.stack);
    return res.status(500).json({ success: false, message: 'Internal server error', debug: error.message });
  }
};

// ── Fuel Charges (Recovery Officer) ────────────────────────────────────────
// Aggregates fuel_charges recorded against installment payments collected by
// this officer (see submitInstallment), filtered by paid_at date range.
const getRecoveryFuelCharges = async (req, res) => {
  try {
    const { filter = 'today', startDate, endDate } = req.query;
    const userId = req.user?.id;

    const nowDt = new Date();
    let start, end;

    if (filter === 'today') {
      start = new Date(nowDt); start.setHours(0, 0, 0, 0);
      end = new Date(nowDt); end.setHours(23, 59, 59, 999);
    } else if (filter === 'month') {
      start = new Date(nowDt.getFullYear(), nowDt.getMonth(), 1, 0, 0, 0, 0);
      end = new Date(nowDt.getFullYear(), nowDt.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (filter === 'custom' && startDate && endDate) {
      start = new Date(startDate); start.setHours(0, 0, 0, 0);
      end = new Date(endDate); end.setHours(23, 59, 59, 999);
    } else {
      start = new Date(nowDt); start.setHours(0, 0, 0, 0);
      end = new Date(nowDt); end.setHours(23, 59, 59, 999);
    }

    const orders = await prisma.order.findMany({
      where: {
        recovery_officer_id: userId,
        status: { in: ['pending', 'in_progress', 'delivered'] },
        is_delivered: true
      },
      include: {
        installment_ledger: true,
        verification: { include: { purchaser: true } },
        delivery: true,
        cash_in_hand: { orderBy: { created_at: 'desc' }, take: 1 }
      }
    });

    // ── Resolve the ACTUAL delivered product by IMEI, not the suggested
    // product_name stored on the order at creation time ─────────────────
    const fuelOrdersImeis = orders
      .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
      .filter(Boolean);

    const fuelOrdersInventories = await prisma.outletInventory.findMany({
      where: { imei_serial: { in: fuelOrdersImeis } },
      select: { imei_serial: true, product_name: true }
    });

    const fuelOrdersInventoryMap = new Map();
    for (const inv of fuelOrdersInventories) {
      if (inv.imei_serial) fuelOrdersInventoryMap.set(inv.imei_serial, inv);
    }

    let totalFuelAmount = 0;
    const entries = [];

    orders.forEach(order => {
      if (!order.installment_ledger?.ledger_rows) return;

      let rawRows = order.installment_ledger.ledger_rows;
      if (typeof rawRows === 'string') rawRows = JSON.parse(rawRows);
      if (!Array.isArray(rawRows)) return;

      const normalized = getNormalizedLedger(rawRows);

      const imeiSerial = order.cash_in_hand?.[0]?.imei_serial || order.delivery?.product_imei || order.imei_serial;
      const invInfo = imeiSerial ? fuelOrdersInventoryMap.get(imeiSerial) : null;
      const deliveredProductName = invInfo?.product_name || order.cash_in_hand?.[0]?.product_name || order.product_name || '';

      normalized.rows.forEach(row => {
        const fuelAmount = parseFloat(row.fuel_charges || 0);
        if (fuelAmount <= 0) return;
        if (Number(row.collected_by) !== Number(userId)) return;

        const paidAt = row.paid_at ? new Date(row.paid_at) : null;
        if (!paidAt || isNaN(paidAt.getTime())) return;
        if (paidAt < start || paidAt > end) return;

        totalFuelAmount += fuelAmount;
        entries.push({
          orderId: order.id,
          orderRef: order.order_ref || '',
          customerName: order.verification?.purchaser?.name || order.customer_name || '',
          cnicNumber: order.verification?.purchaser?.cnic_number || null,
          itemName: deliveredProductName,
          monthNumber: row.month ?? 0,
          fuelAmount,
          paymentAmount: parseFloat(row.paid_amount || 0),
          paymentMethod: row.payment_method || '',
          paidAt: paidAt.toISOString()
        });
      });
    });

    entries.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));

    return res.status(200).json({
      success: true,
      data: {
        filter,
        dateRange: { start, end },
        totalFuelAmount,
        count: entries.length,
        entries
      }
    });
  } catch (error) {
    console.error('getRecoveryFuelCharges error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error', debug: error.message });
  }
};

// ── Collected Payments (Recovery Officer) ──────────────────────────────────
// Every installment payment recorded against orders currently assigned to
// this officer, filtered by paid_at date range — with payment method and
// the officer who actually collected each one (collected_by may differ from
// the officer currently assigned, e.g. after a reassignment).
const getRecoveryCollectedPayments = async (req, res) => {
  try {
    const { filter = 'today', startDate, endDate, paymentMethod, search } = req.query;
    const userId = req.user?.id;

    const nowDt = new Date();
    let start, end;

    if (filter === 'today') {
      start = new Date(nowDt); start.setHours(0, 0, 0, 0);
      end = new Date(nowDt); end.setHours(23, 59, 59, 999);
    } else if (filter === 'month') {
      start = new Date(nowDt.getFullYear(), nowDt.getMonth(), 1, 0, 0, 0, 0);
      end = new Date(nowDt.getFullYear(), nowDt.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (filter === 'custom' && startDate && endDate) {
      start = new Date(startDate); start.setHours(0, 0, 0, 0);
      end = new Date(endDate); end.setHours(23, 59, 59, 999);
    } else {
      start = new Date(nowDt); start.setHours(0, 0, 0, 0);
      end = new Date(nowDt); end.setHours(23, 59, 59, 999);
    }

    const orders = await prisma.order.findMany({
      where: {
        recovery_officer_id: userId,
        status: { in: ['pending', 'in_progress', 'delivered'] },
        is_delivered: true
      },
      include: {
        installment_ledger: true,
        verification: { include: { purchaser: true } },
        delivery: true,
        cash_in_hand: { orderBy: { created_at: 'desc' }, take: 1 }
      }
    });

    // ── Resolve the ACTUAL delivered product by IMEI, not the suggested
    // product_name stored on the order at creation time ─────────────────
    const allImeis = orders
      .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
      .filter(Boolean);

    const inventories = await prisma.outletInventory.findMany({
      where: { imei_serial: { in: allImeis } },
      select: { imei_serial: true, product_name: true }
    });

    const inventoryMap = new Map();
    for (const inv of inventories) {
      if (inv.imei_serial) inventoryMap.set(inv.imei_serial, inv);
    }

    const isCashMethod = (m) => ['cash', 'recovery_cash', 'recovery cash'].includes((m || '').toLowerCase());

    const rawEntries = [];

    orders.forEach(order => {
      if (!order.installment_ledger?.ledger_rows) return;

      let rawRows = order.installment_ledger.ledger_rows;
      if (typeof rawRows === 'string') rawRows = JSON.parse(rawRows);
      if (!Array.isArray(rawRows)) return;

      const normalized = getNormalizedLedger(rawRows);

      const imeiSerial = order.cash_in_hand?.[0]?.imei_serial || order.delivery?.product_imei || order.imei_serial;
      const invInfo = imeiSerial ? inventoryMap.get(imeiSerial) : null;
      const deliveredProductName = invInfo?.product_name || order.cash_in_hand?.[0]?.product_name || order.product_name || '';

      normalized.rows.forEach(row => {
        const paymentAmount = parseFloat(row.paid_amount || 0);
        if (paymentAmount <= 0) return;

        const paidAt = row.paid_at ? new Date(row.paid_at) : null;
        if (!paidAt || isNaN(paidAt.getTime())) return;
        if (paidAt < start || paidAt > end) return;

        rawEntries.push({
          orderId: order.id,
          orderRef: order.order_ref || '',
          customerName: order.verification?.purchaser?.name || order.customer_name || '',
          itemName: deliveredProductName,
          monthNumber: row.month ?? 0,
          amount: paymentAmount,
          paymentMethod: row.payment_method || '',
          officerId: row.collected_by != null ? Number(row.collected_by) : null,
          paidAt: paidAt.toISOString()
        });
      });
    });

    // Resolve officer names for whoever actually collected each payment
    const officerIds = [...new Set(rawEntries.map(e => e.officerId).filter(Boolean))];
    const officers = officerIds.length > 0
      ? await prisma.user.findMany({
        where: { id: { in: officerIds } },
        select: { id: true, full_name: true }
      })
      : [];
    const officerNameMap = officers.reduce((acc, o) => { acc[o.id] = o.full_name; return acc; }, {});

    let payments = rawEntries.map(e => ({
      ...e,
      officerName: e.officerId != null ? (officerNameMap[e.officerId] || 'Unknown') : 'Unknown'
    }));

    if (paymentMethod === 'cash') {
      payments = payments.filter(p => isCashMethod(p.paymentMethod));
    } else if (paymentMethod === 'online') {
      payments = payments.filter(p => !isCashMethod(p.paymentMethod));
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      payments = payments.filter(p =>
        (p.customerName || '').toLowerCase().includes(q) ||
        (p.orderRef || '').toLowerCase().includes(q)
      );
    }

    payments.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));

    const totalAmount = payments.reduce((s, p) => s + p.amount, 0);
    const cashAmount = payments.filter(p => isCashMethod(p.paymentMethod)).reduce((s, p) => s + p.amount, 0);
    const onlineAmount = totalAmount - cashAmount;

    return res.status(200).json({
      success: true,
      data: {
        filter,
        dateRange: { start, end },
        totalAmount,
        cashAmount,
        onlineAmount,
        count: payments.length,
        payments
      }
    });
  } catch (error) {
    console.error('getRecoveryCollectedPayments error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error', debug: error.message });
  }
};

const getRecoveryVisits = async (req, res) => {
  try {
    const { filter = 'today', startDate, endDate } = req.query;
    const userId = req.user.id;

    const nowDt = new Date();
    let start, end;

    if (filter === 'today') {
      start = new Date(nowDt); start.setHours(0, 0, 0, 0);
      end = new Date(nowDt); end.setHours(23, 59, 59, 999);
    } else if (filter === 'month') {
      start = new Date(nowDt.getFullYear(), nowDt.getMonth(), 1, 0, 0, 0, 0);
      end = new Date(nowDt.getFullYear(), nowDt.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (filter === 'custom' && startDate && endDate) {
      start = new Date(startDate); start.setHours(0, 0, 0, 0);
      end = new Date(endDate); end.setHours(23, 59, 59, 999);
    } else {
      start = new Date(nowDt); start.setHours(0, 0, 0, 0);
      end = new Date(nowDt); end.setHours(23, 59, 59, 999);
    }

    const dateFilter = { gte: start, lte: end };

    const visits = await prisma.recoveryVisit.findMany({
      where: {
        officer_id: userId,
        visit_time: dateFilter
      },
      include: {
        order: {
          select: {
            order_ref: true,
            customer_name: true,
            address: true,
            area: true,
            city: true,
            verification: {
              include: {
                purchaser: {
                  select: { name: true }
                }
              }
            }
          }
        },
        photos: true
      },
      orderBy: { visit_time: 'desc' }
    });

    const transformedVisits = visits.map(v => ({
      id: v.id,
      orderId: v.order_id,
      orderRef: v.order?.order_ref || 'N/A',
      customerName: v.order?.verification?.purchaser?.name || v.order?.customer_name || 'Unknown',
      address: v.order?.address || null,
      area: v.order?.area || null,
      city: v.order?.city || null,
      visitTime: v.visit_time,
      paymentCollected: v.payment_collected,
      amountCollected: v.amount_collected || 0,
      customerFeedback: v.customer_feedback,
      notes: v.visit_notes,
      fuelCharges: v.fuel_charges || 0,
      latitude: v.latitude,
      longitude: v.longitude,
      photos: v.photos.map(p => p.file_url)
    }));

    const totalRecoveredAmount = transformedVisits.reduce((s, v) => s + (v.amountCollected || 0), 0);
    const paidVisits = transformedVisits.filter(v => v.paymentCollected).length;

    return res.json({
      success: true,
      data: {
        filter,
        dateRange: { start, end },
        count: transformedVisits.length,
        totalRecoveredAmount,
        paidVisits,
        unpaidVisits: transformedVisits.length - paidVisits,
        visits: transformedVisits
      }
    });
  } catch (error) {
    console.error('getRecoveryVisits error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Promise To Pay (PTP) Day Book — Recovery Officer ────────────────────────
const getRecoveryPtpList = async (req, res) => {
  const officerId = req.user.id;
  const { filter, startDate, endDate } = req.query;

  try {
    // Get all active orders for this recovery officer
    const orders = await prisma.order.findMany({
      where: { recovery_officer_id: officerId, is_delivered: true },
      select: {
        id: true, order_ref: true, customer_name: true, whatsapp_number: true, city: true, area: true,
        product_name: true, imei_serial: true,
        installment_ledger: true,
        delivery: true,
        cash_in_hand: { orderBy: { created_at: 'desc' }, take: 1 },
        verification: { select: { purchaser: { select: { name: true, cnic_number: true } } } }
      },
    });

    if (orders.length === 0) {
      return res.json({ success: true, data: { filter: filter || null, count: 0, ptpList: [], summary: { active: 0, fulfilled: 0, broken: 0 } } });
    }

    const orderIds = orders.map(o => o.id);
    const orderMap = new Map(orders.map(o => [o.id, o]));

    // ── Resolve the ACTUAL delivered product by IMEI, not the suggested
    // product_name stored on the order at creation time ─────────────────
    const ptpOrdersImeis = orders
      .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
      .filter(Boolean);

    const ptpOrdersInventories = await prisma.outletInventory.findMany({
      where: { imei_serial: { in: ptpOrdersImeis } },
      select: { imei_serial: true, product_name: true }
    });

    const ptpOrdersInventoryMap = new Map();
    for (const inv of ptpOrdersInventories) {
      if (inv.imei_serial) ptpOrdersInventoryMap.set(inv.imei_serial, inv);
    }

    const getDeliveredProductName = (order) => {
      const imeiSerial = order?.cash_in_hand?.[0]?.imei_serial || order?.delivery?.product_imei || order?.imei_serial;
      const invInfo = imeiSerial ? ptpOrdersInventoryMap.get(imeiSerial) : null;
      return invInfo?.product_name || order?.cash_in_hand?.[0]?.product_name || order?.product_name || '';
    };

    // Date range for filter
    let dateWhere = {};
    if (filter) {
      const nowDt = new Date();
      let start, end;
      if (filter === 'today') {
        start = new Date(nowDt); start.setHours(0, 0, 0, 0);
        end = new Date(nowDt); end.setHours(23, 59, 59, 999);
      } else if (filter === 'month') {
        start = new Date(nowDt.getFullYear(), nowDt.getMonth(), 1, 0, 0, 0, 0);
        end = new Date(nowDt.getFullYear(), nowDt.getMonth() + 1, 0, 23, 59, 59, 999);
      } else if (filter === 'custom' && startDate && endDate) {
        start = new Date(startDate); start.setHours(0, 0, 0, 0);
        end = new Date(endDate); end.setHours(23, 59, 59, 999);
      }
      if (start && end) {
        dateWhere = { promised_date: { gte: start, lte: end } };
      }
    }

    // ── Source of truth: RecoveryVisit.promised_date ────────────────────────
    // A promise is recorded here the moment the officer sets it — whether or
    // not the order has a PayTrigger-enrolled device. Device enrollment only
    // adds an optional unlock action on top; it never gates the promise
    // itself from showing up here.
    const visits = await prisma.recoveryVisit.findMany({
      where: {
        order_id: { in: orderIds },
        promised_date: { not: null },
        ...dateWhere,
      },
      orderBy: { created_at: 'desc' },
    });

    // A renewed/extended promise replaces the old one — keep only the most
    // recently created visit per order so the same order never shows up
    // twice (once with the stale promise, once with the new one).
    const latestVisitByOrderId = new Map();
    for (const visit of visits) {
      if (!latestVisitByOrderId.has(visit.order_id)) {
        latestVisitByOrderId.set(visit.order_id, visit);
      }
    }
    const latestVisits = Array.from(latestVisitByOrderId.values());

    // Best-effort device lookup per order — purely for showing lock/unlock
    // context on an entry when one happens to exist; absence of a device
    // never excludes the promise from this list.
    const devices = await prisma.payTriggerDevice.findMany({
      where: { order_id: { in: orderIds } },
    });
    const deviceByOrderId = new Map(devices.map(d => [d.order_id, d]));

    // Pulls the next unpaid installment (amount/date) + overall remaining
    // balance for an order, so the mobile app can sort PTP accounts by them.
    const getOrderLedgerBrief = (order) => {
      const empty = { installmentAmount: 0, remainingBalance: 0, totalRemaining: 0, nextInstallmentDate: null };
      try {
        let rawRows = order?.installment_ledger?.ledger_rows;
        if (!rawRows) return empty;
        if (typeof rawRows === 'string') rawRows = JSON.parse(rawRows);
        if (!Array.isArray(rawRows)) return empty;

        const normalized = getNormalizedLedger(rawRows);
        const nextUnpaid = normalized.installment_ledger.find(r => r.status !== 'paid');

        return {
          installmentAmount: nextUnpaid?.dueAmount || 0,
          remainingBalance: nextUnpaid?.remainingAmount || 0,
          totalRemaining: normalized.summary?.totalInstallmentRemaining || 0,
          nextInstallmentDate: nextUnpaid?.dueDate || null,
        };
      } catch (e) {
        return empty;
      }
    };

    const summary = { active: 0, fulfilled: 0, broken: 0 };
    const nowDt2 = new Date();
    const ptpList = [];
    for (const visit of latestVisits) {
      const order = orderMap.get(visit.order_id);
      const device = deviceByOrderId.get(visit.order_id) || null;
      const ledgerBrief = getOrderLedgerBrief(order);

      // Fully paid — the promise no longer applies, so drop it from PTP
      // entirely instead of leaving it sitting under "Fulfilled".
      if (ledgerBrief.totalRemaining === 0) continue;

      const status = visit.promised_date < nowDt2 ? 'broken' : 'active';
      summary[status]++;

      ptpList.push({
        id: visit.id,
        imei: device?.imei || order?.imei_serial || '',
        orderId: visit.order_id,
        orderRef: order?.order_ref || 'N/A',
        customerName: order?.verification?.purchaser?.name || order?.customer_name || 'Unknown',
        cnicNumber: order?.verification?.purchaser?.cnic_number || null,
        whatsappNumber: order?.whatsapp_number || null,
        city: order?.city || null,
        area: order?.area || null,
        productModel: device?.product_model || null,
        itemName: getDeliveredProductName(order) || device?.product_model || null,
        installmentAmount: ledgerBrief.installmentAmount,
        remainingBalance: ledgerBrief.remainingBalance,
        totalRemaining: ledgerBrief.totalRemaining,
        nextInstallmentDate: ledgerBrief.nextInstallmentDate,
        ptpStatus: status,
        promisedDate: visit.promised_date?.toISOString() || null,
        previousExpiration: device?.expiration?.toISOString() || null,
        history: [],
        createdAt: visit.created_at?.toISOString() || null,
        updatedAt: visit.created_at?.toISOString() || null,
        deviceEnrolled: !!device,
      });
    }

    return res.json({
      success: true,
      data: {
        filter: filter || null,
        count: ptpList.length,
        summary,
        ptpList,
      },
    });
  } catch (error) {
    console.error('getRecoveryPtpList error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

module.exports = {
  getRecoveryDashboardStats,
  getRecoveryFuelCharges,
  getRecoveryCollectedPayments,
  getRecoveryVisits,
  getAllRecoveryOfficers,
  getRecoveryOfficerStats,
  getRecoveryCustomers,
  getBranchCustomers,
  submitBranchPayment,
  getCollectionStats,
  getDueOverdueInstallments,
  submitCollections,
  generateInstallmentOtp,
  submitInstallment,
  logRecoveryVisit,
  getOrderRecoveryVisits,
  getCustomerFullProfile,
  replaceRecoveryVisitPhoto,
  getRecoveryPtpList,
};