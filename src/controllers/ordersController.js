const prisma = require('../../lib/prisma');
const { logOrderStatusChange } = require('../utils/orderAuditLogger');
const crypto = require('crypto');
const axios = require('axios');
const { notifyUser, notifyAdmins, notifyOutlet } = require('../utils/notificationUtils');
const { logAction } = require('../utils/auditLogger');
const { sendOTP, sendTemplate, sendOrderStatusNotification } = require('../services/watiService');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { getOrCreateCustomer, checkRepeatStatus, updateCsrRanking, getWorkingDaysLeftInMonth } = require('../services/rankingService');

const admin = require('firebase-admin');

// ─── Firebase Init ────────────────────────────────────────────────
if (!admin.apps.length) {
  const _realDate = global._OriginalDate; // prisma.js ne set kiya hua hai
  global.Date = _realDate;               // Firebase ke liye original date

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });

  global.Date = global._PKTDate;         // PKT date wapas
}
// ─────────────────────────────────────────────────────────────────

async function sendOrderAssignmentNotification(order, user, type, io = null) {
  let title = 'New Order Assigned';
  let message = `Order ${order.order_ref} has been assigned to you.`;
  let notificationType = 'order_assignment';

  if (type === 'verification') {
    title = 'New Order Assigned';
    message = `Order ${order.order_ref} has been assigned to you for verification.`;
    notificationType = 'order_assignment';
  } else if (type === 'delivery') {
    title = 'New Order Assigned for Delivery';
    message = `Order ${order.order_ref} has been assigned to you for Delivery.`;
    notificationType = 'delivery_assignment';
  } else if (type === 'recovery') {
    title = 'New Order Assigned for Recovery';
    message = `Order ${order.order_ref} has been assigned to you for Recovery.`;
    notificationType = 'recovery_assignment';
  } else if (type === 'verification_location') {
    title = 'New Task Assigned for Verification';
    message = `Please verify and capture home location for order ${order.order_ref}.`;
    notificationType = 'order_assignment';
  } else if (type === 'delivery_location') {
    title = 'New Task Assigned for Delivery';
    message = `Please update the delivery location for order ${order.order_ref}.`;
    notificationType = 'delivery_assignment';
  }

  // Save to DB and emit Socket.io
  if (user?.id) {
    await notifyUser(user.id, title, message, notificationType, order.id, io);
  }

  if (!user?.fcm_token) return;

  global.Date = global._OriginalDate;

  try {
    await admin.messaging().send({
      token: user.fcm_token,
      notification: { title, body: message },
      data: {
        order_id: order.id.toString(),
        order_ref: order.order_ref,
        type: notificationType,
      },
    });
  } catch (fcmError) {
    console.error('FCM send failed:', fcmError);
  } finally {
    // ─── PKT date wapas lagao ───────────────────────
    global.Date = global._PKTDate;
  }

}

async function sendOrderTransferNotification(order, outletId, io = null) {
  const users = await prisma.user.findMany({
    where: { outlet_id: outletId },
    select: { id: true }
  });

  const title = 'New Order Transferred';
  const message = `Order ${order.order_ref} has been transferred to your outlet.`;
  const notificationType = 'order_transfer';

  for (const user of users) {
    // We only send to dashboard (Database + Socket.io), NOT to mobile app FCM
    await notifyUser(user.id, title, message, notificationType, order.id, io);
  }
}

async function sendOrderUntransferNotification(order, outletId, io = null) {
  const users = await prisma.user.findMany({
    where: { outlet_id: outletId },
    select: { id: true }
  });

  const title = 'Order Taken Back';
  const message = `Order ${order.order_ref} has been taken back from your outlet.`;
  const notificationType = 'order_untransfer';

  for (const user of users) {
    await notifyUser(user.id, title, message, notificationType, order.id, io);
  }
}

/**
 * Counts the number of Sundays between two dates
 */
function countSundaysBetween(start, end) {
  let count = 0;
  let current = new Date(start);
  // Iterate through each day to find Sundays
  while (current <= end) {
    if (current.getDay() === 0) { // 0 is Sunday
      count++;
    }
    current.setDate(current.getDate() + 1);
  }
  return count;
}


const expireOrders = async (io = null) => {
  const now = new Date();
  const statuses = ['new', 'transferred', 'pending', 'in_progress', 'completed', 'approved'];

  // Fetch all orders that might be eligible for expiration
  const orders = await prisma.order.findMany({
    where: {
      status: { in: statuses },
      cancelled_at: null,
    },
    include: {
      assigned_to: true,
      statusHistories: {
        orderBy: { created_at: 'desc' },
        take: 1,
      },
    },
  });

  if (orders.length === 0) {
    return { expiredCount: 0 };
  }

  const ordersToExpire = [];

  for (const order of orders) {
    if (order.status.toLowerCase() === 'cancelled') continue;

    // Get the timestamp when the order entered its current status
    // Fallback to order.created_at if no history is found or if it doesn't match current status
    const latestHistory = order.statusHistories[0];
    let effectiveTime = new Date(order.created_at);

    if (latestHistory && latestHistory.new_status.toLowerCase() === order.status.toLowerCase()) {
      effectiveTime = new Date(latestHistory.created_at);
    }

    let expirationDurationMs = 0;

    switch (order.status.toLowerCase()) {
      case 'new':
        if (!order.outlet_id) {
          expirationDurationMs = 7 * 24 * 60 * 60 * 1000; // 7 days: Not transferred to outlet
        } else {
          expirationDurationMs = 2 * 24 * 60 * 60 * 1000; // 2 days: At outlet but no action
        }
        break;
      case 'transferred':
        expirationDurationMs = 2 * 24 * 60 * 60 * 1000; // 2 days: Transferred but no action
        break;
      case 'pending':
        expirationDurationMs = 3 * 24 * 60 * 60 * 1000; // 3 days: Assigned to VO but no action
        break;
      case 'in_progress':
        expirationDurationMs = 3 * 24 * 60 * 60 * 1000; // 3 days: Verification started but not complete
        break;
      case 'completed':
      case 'approved':
        expirationDurationMs = 30 * 24 * 60 * 60 * 1000; // 30 days: Verification done, waiting for delivery
        break;
      default:
        continue;
    }

    const sundaysCount = countSundaysBetween(effectiveTime, now);
    const additionalMs = sundaysCount * 24 * 60 * 60 * 1000;
    const totalAllowedMs = expirationDurationMs + additionalMs;

    if (now.getTime() - effectiveTime.getTime() > totalAllowedMs) {
      ordersToExpire.push(order);
    }
  }

  if (ordersToExpire.length === 0) {
    return { expiredCount: 0 };
  }

  const orderIds = ordersToExpire.map((order) => order.id);

  // Bulk update status to expired
  await prisma.order.updateMany({
    where: { id: { in: orderIds } },
    data: { 
      status: 'expired',
      updated_at: new Date(),  
   },
  });

  for (const order of ordersToExpire) {
    // Log the expiration in history
    await logOrderStatusChange(order.id, order.status, 'expired', { id: null, role: 'System' });

    const orderData = {
      id: order.id,
      order_ref: order.order_ref,
      previous_status: order.status,
      updated_at: new Date(),
    };

    // Emit Socket.IO events for real-time updates (for list refreshing)
    if (io) {
      if (order.assigned_to_user_id) {
        io.to(`user_${order.assigned_to_user_id}`).emit('order_expired', orderData);
      }
      if (order.outlet_id) {
        io.to(`outlet_${order.outlet_id}`).emit('order_expired', orderData);
      }
      io.to('admins').emit('order_expired', orderData);
    }

    // Send notifications (Database + Toast)
    const title = 'Order Expired';
    const message = `Order ${order.order_ref} has been marked expired due to inactivity.`;
    const type = 'order_expired';

    // 1. Notify the assigned officer
    if (order.assigned_to_user_id) {
      await notifyUser(order.assigned_to_user_id, title, message, type, order.id, io);
    }

    // 2. Notify the outlet (Branch Users/Sales Officers)
    if (order.outlet_id) {
      await notifyOutlet(order.outlet_id, title, message, type, order.id, io);
    }

    // 3. Notify all active admins
    await notifyAdmins(title, message, type, order.id, io);
  }

  return { expiredCount: ordersToExpire.length };
};

function getDateRangeFilter(range, start, end) {
  const now = new Date();
  let gte, lt;

  switch (range) {
    case 'Day':
      gte = new Date();
      gte.setHours(0, 0, 0, 0);
      lt = new Date(gte);
      lt.setDate(lt.getDate() + 1);
      break;
    case 'Week':
      gte = new Date();
      gte.setDate(now.getDate() - 7);
      gte.setHours(0, 0, 0, 0);
      lt = new Date(now);
      break;
    case 'Month':
      gte = new Date(now.getFullYear(), now.getMonth(), 1);
      lt = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      break;
    case 'Quarter':
      const currentQuarter = Math.floor(now.getMonth() / 3);
      gte = new Date(now.getFullYear(), currentQuarter * 3, 1);
      lt = new Date(now.getFullYear(), (currentQuarter + 1) * 3, 0, 23, 59, 59, 999);
      break;
    case 'Year':
      gte = new Date(now.getFullYear(), 0, 1);
      lt = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      break;
    case 'Custom Range':
      if (start && end) {
        gte = new Date(start);
        lt = new Date(end);
        lt.setHours(23, 59, 59, 999);
      }
      break;
    default:
      return null;
  }
  return { gte, lt };
}

const createOrder = async (req, res) => {
  const {
    customer_name,
    whatsapp_number,
    alternate_contact,
    address,
    city,
    area,
    product_name,
    total_amount,
    advance_amount,
    monthly_amount,
    months,
    channel,
    gender,
    marital_status,
    residential_type,
    zone,
    block,
    street,
    house_no,
    order_notes,
  } = req.body;

  if (!customer_name || !whatsapp_number || !address || !product_name ||
    !total_amount || !advance_amount || !monthly_amount || !months || !channel) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Required fields are missing.' }
    });
  }

  const validGenders = ['Male', 'Female', 'Unidentified'];
  const validMaritalStatuses = ['Single', 'Married', 'Divorced', 'Widowed'];
  const validResidentialTypes = ['Own', 'Rented', 'With Family'];

  if (gender && !validGenders.includes(gender)) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: `Invalid gender. Allowed: ${validGenders.join(', ')}` }
    });
  }

  if (marital_status && !validMaritalStatuses.includes(marital_status)) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: `Invalid marital status. Allowed: ${validMaritalStatuses.join(', ')}` }
    });
  }

  if (residential_type && !validResidentialTypes.includes(residential_type)) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: `Invalid residential type. Allowed: ${validResidentialTypes.join(', ')}` }
    });
  }

  try {
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existingOrders = await prisma.order.findMany({
      where: {
        OR: [
          { whatsapp_number: whatsapp_number.trim() }
        ],
        created_at: { gte: today, lt: tomorrow },
      },
      select: { id: true, whatsapp_number: true, status: true }
    });

    const sameDayDuplicate = existingOrders.find(
      o => o.whatsapp_number === whatsapp_number.trim()
        && o.product_name?.toLowerCase() === product_name.trim().toLowerCase()
    );

    if (sameDayDuplicate) {
      return res.status(409).json({
        success: false,
        error: {
          code: 409,
          message: 'Duplicate active order detected today for this customer and product.'
        }
      });
    }

    const activeOrderCount = await prisma.order.count({
      where: {
        whatsapp_number: whatsapp_number.trim()
      }
    });

    if (activeOrderCount >= 2) {
      return res.status(409).json({
        success: false,
        error: {
          code: 409,
          message: 'Customer already has 2 or more active orders. Maximum 2 active accounts allowed.'
        }
      });
    }

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const order_ref = `QIST-${dateStr}-${randomNum}`;

    const token_number = crypto.randomBytes(4).toString('hex').toUpperCase();

    // Auto-assignment logic
    let assignedOfficerId = null;
    let deliveryOfficerId = null;
    let recoveryOfficerId = null;

    const userRole = (req.user?.role || '').toLowerCase();
    const isSalesOfficer = userRole === 'sales officer';

    // Self-assignment for field officers creating their own orders
    if (userRole === 'verification officer') {
      assignedOfficerId = req.user.id;
    } else if (userRole === 'delivery agent') {
      deliveryOfficerId = req.user.id;
    } else if (userRole === 'recovery officer') {
      recoveryOfficerId = req.user.id;
    } else if (!isSalesOfficer && zone && area && currentUser?.outlet_id) {
      const { getOutletSettings } = require('../utils/settingsUtils');
      const settings = await getOutletSettings(currentUser.outlet_id);

      // Helper to find officer by role and area within same outlet
      const findOfficer = async (roleName) => {
        const assignment = await prisma.officerAreaAssignment.findFirst({
          where: {
            zone: zone.trim(),
            area: area.trim(),
            user: {
              outlet_id: currentUser.outlet_id,
              role: { name: roleName }
            }
          },
          select: { user_id: true }
        });
        return assignment?.user_id || null;
      };

      if (settings.verification) {
        assignedOfficerId = await findOfficer('Verification Officer');
      }
      if (settings.delivery) {
        deliveryOfficerId = await findOfficer('Delivery Agent');
      }
      if (settings.recovery) {
        recoveryOfficerId = await findOfficer('Recovery Officer');
      }
    }

    const order = await prisma.order.create({
      data: {
        order_ref,
        token_number,
        customer_name: customer_name.trim(),
        whatsapp_number: whatsapp_number.trim(),
        alternate_contact: alternate_contact ? alternate_contact.trim() : null,
        address: address.trim(),
        city: city ? city.trim() : null,
        area: area ? area.trim() : null,
        zone: zone ? zone.trim() : null,
        block: block ? block.trim() : null,
        street: street ? street.trim() : null,
        house_no: house_no ? house_no.trim() : null,
        order_notes: order_notes ? order_notes.trim() : null,

        gender: gender || null,
        marital_status: marital_status || null,
        residential_type: residential_type || null,

        product_name: product_name.trim(),
        total_amount: parseFloat(total_amount),
        advance_amount: parseFloat(advance_amount),
        monthly_amount: parseFloat(monthly_amount),
        months: parseInt(months),
        channel: channel.trim(),
        status: (assignedOfficerId || deliveryOfficerId || recoveryOfficerId) ? 'pending' : 'new',
        created_at: new Date(),
        updated_at: new Date(),
        created_by_user_id: req.user.id,
        outlet_id: currentUser?.outlet_id || null,
        assigned_to_user_id: assignedOfficerId,
        delivery_officer_id: deliveryOfficerId,
        recovery_officer_id: recoveryOfficerId,
        verification_assigned_at: assignedOfficerId ? new Date() : null,
        delivery_assigned_at: deliveryOfficerId ? new Date() : null,
        recovery_assigned_at: recoveryOfficerId ? new Date() : null
      },
      include: {
        created_by: { select: { id: true, username: true, full_name: true } },
        assigned_to: { select: { id: true, username: true, full_name: true } },
        delivery_officer: { select: { id: true, username: true, full_name: true } },
        recovery_officer: { select: { id: true, username: true, full_name: true } },
        verification: {
            include: {
                purchaser: true,
                grantors: true,
                nextOfKin: true,
                documents: true,
                verification_locations: {
                    include: {
                        photos: true
                    }
                }
            }
        },
        statusHistories: {
            include: {
                user: { select: { username: true, full_name: true } }
            },
            orderBy: { created_at: 'desc' }
        }
      }
    });

    await logOrderStatusChange(order.id, null, order.status, req.user);

    // Link customer and check repeat status for ranking
    try {
        const customer = await getOrCreateCustomer(order.id);
        if (customer) {
            const isRepeat = await checkRepeatStatus(customer.id, order.id);
            if (isRepeat) {
                await prisma.order.update({
                    where: { id: order.id },
                    data: { is_repeat_customer: true }
                });
            }
        }
        // Update Ranking snapshots
        await updateCsrRanking(req.user.id, 'month');
        await updateCsrRanking(req.user.id, 'today');
    } catch (rankingError) {
        console.error('Ranking update failed:', rankingError);
    }

    const io = req.app.get('io');
    if (assignedOfficerId) {
      await sendOrderAssignmentNotification(order, order.assigned_to, 'verification', io);
    }
    if (deliveryOfficerId) {
      await sendOrderAssignmentNotification(order, order.delivery_officer, 'delivery', io);
    }
    if (recoveryOfficerId) {
      await sendOrderAssignmentNotification(order, order.recovery_officer, 'recovery', io);
    }

    // Notify Admins about new order
    await notifyAdmins(
      'New Order Created',
      `Order ${order.order_ref} was created by ${order.created_by.username} for ${order.customer_name}.`,
      'order_creation',
      order.id,
      io
    );

    if (req.user.outlet_id) {
      await logAction(
            req,
            'ORDER_CREATION',
            `New order ${order.order_ref} created for ${order.customer_name} (${order.product_name})`,
            order.id,
            'Order'
          );
    }

    return res.status(201).json({
      success: true,
      message: 'Order created successfully.',
      data: {
        order: {
          id: order.id,
          order_ref: order.order_ref,
          token_number: order.token_number,
          status: order.status,
          customer_name: order.customer_name,
          whatsapp_number: order.whatsapp_number,
          alternate_contact: order.alternate_contact,
          address: order.address,
          city: order.city,
          area: order.area,
          zone: order.zone,
          block: order.block,
          street: order.street,
          house_no: order.house_no,
          order_notes: order.order_notes,

          gender: order.gender,
          marital_status: order.marital_status,
          residential_type: order.residential_type,

          product_name: order.product_name,
          total_amount: order.total_amount,
          advance_amount: order.advance_amount,
          monthly_amount: order.monthly_amount,
          months: order.months,
          channel: order.channel,
          created_at: order.created_at,
          created_by: order.created_by?.username || null
        }
      }
    });
  } catch (error) {
    console.error('Create order error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

const cancelWebsiteOrderFeedItem = async (req, res) => {
  const { id } = req.params; // Source order ID
  const { reason, orderData } = req.body;
  const WEBSITE_CANCEL_URL = `https://api.qistmarket.pk/api/orders/${id}/status`;

  if (!reason) {
    return res.status(400).json({ success: false, message: 'Reason is required for cancellation.' });
  }

  try {
    // 1. Notify Website Backend
    try {
      await axios.put(WEBSITE_CANCEL_URL, 
        { status: 'Cancelled', rejectionReason: reason }, 
        {
          headers: { 
            'Content-Type': 'application/json',
            'x-software-backend-secret': 'qist-market-software-secret-123'
          }
        }
      );
    } catch (webErr) {
      console.error('Failed to cancel on website backend:', {
        status: webErr.response?.status,
        data: webErr.response?.data,
        message: webErr.message
      });
    }

    // 2. Use provided order data or fallback to fetch if not provided
    let websiteOrder = orderData;
    
    if (!websiteOrder) {
        const WEBSITE_DETAIL_URL = `https://api.qistmarket.pk/api/orders/${id}`;
        try {
          const detailRes = await axios.get(WEBSITE_DETAIL_URL);
          websiteOrder = detailRes.data?.data;
        } catch (fetchErr) {
          console.error('Failed to fetch website order details:', fetchErr.message);
        }
    }

    if (websiteOrder) {
      // 3. Create a local 'cancelled' record
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const randomNum = Math.floor(1000 + Math.random() * 9000);
      const order_ref = `QIST-${dateStr}-${randomNum}-CAN`;

      const localOrder = await prisma.order.create({
        data: {
          order_ref,
          token_number: websiteOrder.tokenNumber.toString(),
          customer_name: websiteOrder.fullName,
          whatsapp_number: websiteOrder.phone,
          address: websiteOrder.address,
          city: websiteOrder.city,
          area: websiteOrder.area,
          product_name: websiteOrder.productName,
          total_amount: parseFloat(websiteOrder.totalDealValue),
          advance_amount: parseFloat(websiteOrder.advanceAmount),
          monthly_amount: parseFloat(websiteOrder.monthlyAmount),
          months: parseInt(websiteOrder.months),
          channel: 'Website',
          status: 'cancelled',
          cancelled_reason: reason,
          cancelled_at: new Date(),
          created_at: new Date(),
          created_by_user_id: req.user.id,
          order_notes: `Website Cancelled: ${websiteOrder.tokenNumber}. Reason: ${reason}`
        }
      });

      await logOrderStatusChange(localOrder.id, null, 'cancelled', req.user, reason);

      return res.status(200).json({
        success: true,
        message: 'Website order cancelled successfully and local record created.',
        data: { localOrder }
      });
    }

    return res.status(404).json({ success: false, message: 'Could not find website order details to cancel.' });

  } catch (error) {
    console.error('cancelWebsiteOrderFeedItem error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const createOrderFromWebsitePickup = async (req, res) => {
  const {
    customer_name,
    whatsapp_number,
    alternate_contact,
    address,
    city,
    area,
    product_name,
    total_amount,
    advance_amount,
    monthly_amount,
    months,
    channel,
    order_notes,
    website_token_number
  } = req.body;

  if (!customer_name || !whatsapp_number || !address || !product_name ||
    !total_amount || !advance_amount || !monthly_amount || !months || !website_token_number) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Required fields are missing.' }
    });
  }

  try {
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });

    // Check if already picked up
    const existing = await prisma.order.findUnique({
      where: { token_number: website_token_number }
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'This order has already been picked up by someone else.'
      });
    }

    // Generate references
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const order_ref = `QIST-${dateStr}-${randomNum}`;
    // Use website's token number as our unique token number
    const token_number = website_token_number;

    const order = await prisma.order.create({
      data: {
        order_ref,
        token_number,
        customer_name: customer_name.trim(),
        whatsapp_number: whatsapp_number.trim(),
        alternate_contact: alternate_contact ? alternate_contact.trim() : null,
        address: address.trim(),
        city: city ? city.trim() : null,
        area: area ? area.trim() : null,
        product_name: product_name.trim(),
        total_amount: parseFloat(total_amount),
        advance_amount: parseFloat(advance_amount),
        monthly_amount: parseFloat(monthly_amount),
        months: parseInt(months),
        channel: channel || 'Website',
        status: 'new',
        created_at: new Date(),
        updated_at: new Date(),
        created_by_user_id: req.user.id,
        assigned_to_user_id: null,
        verification_assigned_at: null,
        outlet_id: (currentUser?.role?.name?.toLowerCase() === 'sales officer') ? null : (currentUser?.outlet_id || null),
        order_notes: order_notes || `Website Pickup: ${website_token_number}`
      },
      include: {
        created_by: { select: { username: true } },
        assigned_to: { select: { id: true, username: true } }
      }
    });

    await logOrderStatusChange(order.id, null, 'new', req.user, null, true);

    return res.status(201).json({
      success: true,
      message: 'Order picked up and created successfully.',
      data: { order }
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({
        success: false,
        message: 'This order has already been picked up (Unique constraint).'
      });
    }
    console.error('Website pickup error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

const getWebsiteOrderFeed = async (req, res) => {
  const { page = 1, limit = 10, search = '' } = req.query;
  const WEBSITE_API_URL = 'https://api.qistmarket.pk/api/orders';

  try {
    const targetPage = parseInt(page);
    const targetLimit = parseInt(limit);
    const targetOffset = (targetPage - 1) * targetLimit;

    // 1. Get ALL local website token numbers to filter out
    const localOrders = await prisma.order.findMany({
      where: { channel: 'Website' },
      select: { token_number: true }
    });
    const localTokens = localOrders.map(o => o.token_number).join(',');

    // 2. Fetch from Website API with exclusion via POST to avoid "URI Too Large" errors
    const response = await axios.post(`${WEBSITE_API_URL}-feed`, {
      page: targetPage, 
      limit: targetLimit, 
      search,
      excludeTokens: localTokens 
    }, {
      headers: { 'x-software-backend-secret': 'qist-market-software-secret-123' }
    });

    const webData = response.data;

    return res.status(200).json({
      success: true,
      data: webData.data || [],
      pagination: webData.pagination || {
        totalItems: 0,
        totalPages: 1,
        currentPage: targetPage,
        limit: targetLimit
      }
    });
  } catch (error) {
    console.error('Website feed proxy error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch website orders through proxy.'
    });
  }
};

const getOrders = async (req, res) => {
  const { page = 1, limit = 10, search = '', sortBy = 'updated_at', sortDir = 'desc', ...filters } = req.query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const userFromDb = await prisma.user.findUnique({ where: { id: req.user.id } });
    const where = {};
    const userRole = (req.user?.role || '').toLowerCase();

    console.log(userRole);

    if (userRole === 'branch user') {
      where.AND = [
        {
          OR: [
            { outlet_id: userFromDb?.outlet_id || -1 },
            { created_by_user_id: req.user.id }
          ]
        }
      ];
    }

    if (userRole === 'sales officer') {
      where.created_by_user_id = req.user.id;
    }

    if (search.trim()) {
      where.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
        { token_number: { contains: search } },
        { product_name: { contains: search } },
        { city: { contains: search } },
        { area: { contains: search } },
      ];
    }

    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        if (key === 'assigned_to') {
          where.assigned_to = { username: { contains: value } };
        } else if (key === 'created_by') {
          where.created_by = { username: { contains: value } };
        } else if (key === 'delivery_officer') {
          where.delivery_officer = { username: { contains: value } };
        } else if (key === 'recovery_officer') {
          where.recovery_officer = { username: { contains: value } };
        } else if (key === 'status') {
          const statusList = value.split(',').map(s => s.trim());
          if (statusList.length > 1) {
            where.status = { in: statusList };
          } else {
            where.status = { contains: value };
          }
        } else if (key === 'dateRange') {
          const range = getDateRangeFilter(value, filters.startDate, filters.endDate);
          if (range) {
            where.created_at = range;
          }
        } else if (key !== 'startDate' && key !== 'endDate') {
          where[key] = { contains: value };
        }
      }
    });

    const include = {
      created_by: { select: { username: true } },
      assigned_to: { select: { username: true, full_name: true } },
        delivery_officer: { select: { id: true, username: true, full_name: true } },
        recovery_officer: { select: { id: true, username: true, full_name: true } },
      productHistories: {
        include: {
          changed_by: { select: { username: true, full_name: true } }
        },
        orderBy: { changed_at: 'desc' }
      }
    };

    const orders = await prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { [sortBy]: sortDir },
      include,
    });

    const total = await prisma.order.count({ where });

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          page: Number(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNext: skip + take < total,
          hasPrev: Number(page) > 1,
        },
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getOrdersWithPagination = async (req, res) => {
  const { lastId = 0, limit = 10, search = '', ...filters } = req.query;

  const take = Number(limit);
  const cursorId = Number(lastId);

  try {
    const userFromDb = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { role: true }
    });
    const baseWhere = {};
    const userRole = (req.user?.role || '').toLowerCase();

    if (userRole === 'branch user') {
      baseWhere.AND = [
        {
          OR: [
            { outlet_id: userFromDb?.outlet_id || -1 },
            { created_by_user_id: req.user.id }
          ]
        }
      ];
    }

    if (userRole === 'sales officer') {
      baseWhere.created_by_user_id = req.user.id;
    }

    if (search.trim()) {
      baseWhere.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
        { token_number: { contains: search } },
        { product_name: { contains: search } },
        { city: { contains: search } },
        { area: { contains: search } },
      ];
    }

    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        if (key === 'assigned_to') {
          baseWhere.assigned_to = { username: value };
        } else if (key === 'created_by') {
          baseWhere.created_by = { username: value };
        } else if (key === 'delivery_officer') {
          baseWhere.delivery_officer = { username: value };
        } else if (key === 'recovery_officer') {
          baseWhere.recovery_officer = { username: value };
        } else if (key === 'status') {
          const statusList = value.split(',').map(s => s.trim());
          if (statusList.length > 1) {
            baseWhere.status = { in: statusList };
          } else {
            baseWhere.status = value;
          }
        } else if (key === 'channel') {
          const channelList = value.split(',').map(s => s.trim());
          if (channelList.length > 1) {
            baseWhere.channel = { in: channelList };
          } else {
            baseWhere.channel = value;
          }
        } else if (key === 'dateRange') {
          const range = getDateRangeFilter(value, filters.startDate, filters.endDate);
          if (range) {
            baseWhere.created_at = range;
          }
        } else if (key !== 'startDate' && key !== 'endDate') {
          baseWhere[key] = { contains: value };
        }
      }
    });

    const totalCount = await prisma.order.count({
      where: baseWhere
    });

    const where = { ...baseWhere };
    if (cursorId > 0) {
      where.id = { lt: cursorId };
    }

    const orders = await prisma.order.findMany({
      where,
      take,
      orderBy: { id: 'desc' },
      include: {
        created_by: { select: { username: true } },
        assigned_to: { select: { username: true } },
        productHistories: {
          include: {
            changed_by: { select: { username: true, full_name: true } }
          },
          orderBy: { changed_at: 'desc' }
        }
      },
    });

    // Map orders to explicitly include timestamp fields
    const formattedOrders = orders.map(order => ({
      ...order,
      verification_assigned_at: order.verification_assigned_at,
      delivery_assigned_at: order.delivery_assigned_at,
      recovery_assigned_at: order.recovery_assigned_at
    }));

    let nextLastId = null;
    if (orders.length > 0) {
      nextLastId = orders[orders.length - 1].id;
    }

    const hasMore = orders.length === take;

    return res.status(200).json({
      success: true,
      data: {
        orders: formattedOrders,
        pagination: {
          nextLastId,
          hasMore,
          limit: take,
          count: formattedOrders.length,
          totalCount
        },
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const takeOrder = async (req, res) => {
  const { id } = req.params;

  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(id) },
    });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.channel !== 'website' && order.channel !== 'Website') {
      return res.status(400).json({ success: false, message: 'Only website orders can be taken here' });
    }

    if (order.status !== 'new' && order.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Order cannot be taken in its current status' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: Number(id) },
      data: {
        assigned_to_user_id: req.user.id,
        verification_assigned_at: new Date(),
        status: 'pending',
      },
      include: {
        assigned_to: { select: { id: true, username: true } },
      },
    });

    await logOrderStatusChange(updatedOrder.id, order.status, 'pending', req.user);

    return res.status(200).json({
      success: true,
      message: 'Website order taken successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error('takeOrder error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getCsrDashboardStats = async (req, res) => {
  try {
    const { filter = 'today', startDate, endDate } = req.query;
    const userId = req.user.id;
    const userRoleId = req.user.role_id;
    const userRole = (req.user.role || '').toLowerCase();

    // Role detection
    const isCsr = userRoleId === 8 || userRole.includes('sales') || userRole.includes('csr');
    const isAdmin = [4, 6, 7, 9].includes(userRoleId);
    const isOutlet = userRoleId === 5;

    // Trigger async ranking update for the current CSR on visit
    if (isCsr) {
        updateCsrRanking(userId, 'today').catch(err => console.error('Auto-ranking update error:', err));
        updateCsrRanking(userId, 'month').catch(err => console.error('Auto-ranking update error:', err));
    }

    // Date range calculation using PKT
    const now = new Date();
    let start, end;

    if (filter === 'today') {
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
      end = new Date(now);
      end.setHours(23, 59, 59, 999);
    } else if (filter === 'month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (filter === 'custom' && startDate && endDate) {
      start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
    } else {
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
      end = new Date(now);
      end.setHours(23, 59, 59, 999);
    }

    // Yesterday for comparison
    const yesterdayStart = new Date(start);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayEnd = new Date(end);
    yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);

    const dateFilter = { gte: start, lte: end };

    // Base where clause — CSR sees only their own orders
    const baseWhere = {
      updated_at: dateFilter,
      ...(isCsr ? { created_by_user_id: userId } : {}),
    };

    // 1. Status counts
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
    const approvedCount = statusCounts['approved'] || 0;
    const pickedCount = statusCounts['picked'] || 0;
    const rejectedCount = statusCounts['rejected'] || 0;

    const successRate = totalOrders > 0 ? Math.round((deliveredCount / totalOrders) * 100) : 0;
    const cancelRate = totalOrders > 0 ? Math.round((cancelledCount / totalOrders) * 100) : 0;

    // 1.1 Yesterday stats for increment
    const [yesterdayStatusGroups, yesterdayDeliveredOrders] = await prisma.$transaction([
      prisma.order.groupBy({
        by: ['status'],
        where: { ...baseWhere, updated_at: { gte: yesterdayStart, lte: yesterdayEnd } },
        _count: { id: true },
      }),
      prisma.order.findMany({
        where: { ...baseWhere, status: 'delivered', updated_at: { gte: yesterdayStart, lte: yesterdayEnd } },
        select: { total_amount: true }
      })
    ]);

    const yesterdayCounts = yesterdayStatusGroups.reduce((acc, item) => {
      acc[item.status] = item._count.id;
      return acc;
    }, {});

    const yesterdaySales = yesterdayDeliveredOrders.reduce((sum, o) => sum + (o.total_amount || 0), 0);

    // 1.1 Target tracking base — total_amount from delivered orders for current period
    const deliveredOrders = await prisma.order.findMany({
      where: { ...baseWhere, status: 'delivered' },
      select: { total_amount: true }
    });
    const achievedAmount = deliveredOrders.reduce((sum, order) => sum + (order.total_amount || 0), 0);
    const achievedCustomers = deliveredCount;

    const calcIncrement = (curr, prev) => {
      if (!prev || prev === 0) return curr > 0 ? 100 : 0;
      return Math.round(((curr - prev) / prev) * 100);
    };

    const todayIncrement = {
      total: calcIncrement(totalOrders, Object.values(yesterdayCounts).reduce((a, b) => a + b, 0)),
      new: calcIncrement(newCount, yesterdayCounts['new']),
      pending: calcIncrement(pendingCount, yesterdayCounts['pending']),
      delivered: calcIncrement(deliveredCount, yesterdayCounts['delivered']),
      approved: calcIncrement(approvedCount, yesterdayCounts['approved']),
      cancelled: calcIncrement(cancelledCount, yesterdayCounts['cancelled']),
      expired: calcIncrement(expiredCount, yesterdayCounts['expired']),
      sales: calcIncrement(achievedAmount, yesterdaySales),
      in_progress: calcIncrement(inProgressCount, yesterdayCounts['in_progress']),
      picked: calcIncrement(pickedCount, yesterdayCounts['picked']),
      completed: calcIncrement(completedCount, yesterdayCounts['completed']),
      rejected: calcIncrement(rejectedCount, yesterdayCounts['rejected']),
    };

    // Calculate overall Success Rate increment (vs yesterday)
    const yesterdayTotal = Object.values(yesterdayCounts).reduce((a, b) => a + b, 0);
    const yesterdaySuccessRate = yesterdayTotal > 0 ? Math.round(((yesterdayCounts['delivered'] || 0) / yesterdayTotal) * 100) : 0;
    const successRateIncrement = successRate - yesterdaySuccessRate;

    const avgTicketSize = deliveredCount > 0 ? Math.round(achievedAmount / deliveredCount) : 0;
    const yesterdayAvgTicketSize = (yesterdayCounts['delivered'] || 0) > 0 ? Math.round(yesterdaySales / yesterdayCounts['delivered']) : 0;
    const avgTicketIncrement = calcIncrement(avgTicketSize, yesterdayAvgTicketSize);

    // 2. Channel breakdown (with status sub-grouping)
    const channelGroups = await prisma.order.groupBy({
      by: ['channel', 'status'],
      where: baseWhere,
      _count: { id: true },
    });

    const channelMap = {};
    channelGroups.forEach(item => {
      const ch = (item.channel || 'unknown').toLowerCase();
      if (!channelMap[ch]) channelMap[ch] = { total: 0, delivered: 0, cancelled: 0 };
      channelMap[ch].total += item._count.id;
      if (item.status === 'delivered') channelMap[ch].delivered += item._count.id;
      if (item.status === 'cancelled') channelMap[ch].cancelled += item._count.id;
    });

    const buildChannelStats = (names) => {
      const combined = { total: 0, delivered: 0, cancelled: 0 };
      names.forEach(n => {
        const data = channelMap[n.toLowerCase()];
        if (data) {
          combined.total += data.total;
          combined.delivered += data.delivered;
          combined.cancelled += data.cancelled;
        }
      });
      combined.successRate = combined.total > 0 ? Math.round((combined.delivered / combined.total) * 100) : 0;
      combined.cancelRate = combined.total > 0 ? Math.round((combined.cancelled / combined.total) * 100) : 0;
      return combined;
    };

    const channelStats = {
      referral: buildChannelStats(['referral']),
      call: buildChannelStats(['call']),
      whatsapp: buildChannelStats(['whatsapp', 'whats_app', 'whats app']),
      website: buildChannelStats(['website']),
    };

    const monthlyTarget = Number(process.env.CSR_MONTHLY_TARGET || process.env.CSR_SALES_TARGET || 1286500); 
    const customerTarget = Number(process.env.CSR_CUSTOMER_TARGET || 486); 
    const remainingAmount = monthlyTarget > 0 ? Math.max(0, monthlyTarget - achievedAmount) : 0;
    const remainingCustomers = customerTarget > 0 ? Math.max(0, customerTarget - achievedCustomers) : 0;

    // Working days logic (excluding Sundays)
    const workingDaysLeft = getWorkingDaysLeftInMonth();
    
    // Calculate elapsed working days so far this month
    const getWorkingDaysSoFar = () => {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      let count = 0;
      let curr = new Date(monthStart);
      while (curr <= now) {
        if (curr.getDay() !== 0) count++;
        curr.setDate(curr.getDate() + 1);
      }
      return count || 1;
    };
    const workingDaysSoFar = getWorkingDaysSoFar();

    const dailyAvgRequired = workingDaysLeft > 0 ? Math.round(remainingCustomers / workingDaysLeft) : 0;
    const currentDailyAvg = Math.round((achievedCustomers / workingDaysSoFar) * 100) / 100;

    const targetTracking = {
      monthlyTarget,
      achievedAmount,
      remainingAmount,
      achievedCustomers,
      customerTarget,
      remainingCustomers,
      dailyAvgRequired,
      currentDailyAvg,
      remainingDays: workingDaysLeft,
      progressPct: customerTarget > 0 ? Math.round((achievedCustomers / customerTarget) * 100) : 0,
      avgTicketSize,
      avgTicketIncrement,
      successRateIncrement,
      overallTodayIncrement: todayIncrement.total // Match the big "TODAY INCREMENT" card
    };

    // 4. Historical Data for Graphs (This Month vs Last Month)
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    const getDailyStats = async (periodStart, periodEnd) => {
        const orders = await prisma.order.findMany({
            where: {
                status: 'delivered',
                updated_at: { gte: periodStart, lte: periodEnd },
                ...(isCsr ? { created_by_user_id: userId } : {})
            },
            select: { updated_at: true, total_amount: true }
        });

        const daily = {};
        orders.forEach(o => {
            const day = o.updated_at.getDate();
            if (!daily[day]) daily[day] = { amount: 0, customers: 0 };
            daily[day].amount += (o.total_amount || 0);
            daily[day].customers += 1;
        });
        return daily;
    };

    const thisMonthDaily = await getDailyStats(thisMonthStart, end);
    const lastMonthDaily = await getDailyStats(lastMonthStart, lastMonthEnd);

    // Format for frontend (arrays of values for days 1-31)
    const graphData = {
        days: Array.from({ length: 31 }, (_, i) => i + 1),
        sales: {
            current: Array.from({ length: 31 }, (_, i) => thisMonthDaily[i + 1]?.amount || 0),
            previous: Array.from({ length: 31 }, (_, i) => lastMonthDaily[i + 1]?.amount || 0)
        },
        customers: {
            current: Array.from({ length: 31 }, (_, i) => thisMonthDaily[i + 1]?.customers || 0),
            previous: Array.from({ length: 31 }, (_, i) => lastMonthDaily[i + 1]?.customers || 0)
        }
    };

    // 5. Outlet Performance
    const outletStats = await prisma.order.groupBy({
        by: ['outlet_id', 'status'],
        where: baseWhere,
        _count: { id: true },
    });

    const outletsRaw = await prisma.outlet.findMany({
        select: { id: true, name: true }
    });

    const outletPerformanceMap = {};
    outletStats.forEach(stat => {
        const oid = stat.outlet_id;
        if (!oid) return;
        if (!outletPerformanceMap[oid]) outletPerformanceMap[oid] = { id: oid, name: outletsRaw.find(o => o.id === oid)?.name || 'Unknown', total: 0, delivered: 0 };
        outletPerformanceMap[oid].total += stat._count.id;
        if (stat.status === 'delivered') outletPerformanceMap[oid].delivered += stat._count.id;
    });

    const outletPerformance = Object.values(outletPerformanceMap)
        .map(o => ({
            ...o,
            successRate: o.total > 0 ? Math.round((o.delivered / o.total) * 100) : 0
        }))
        .sort((a, b) => b.successRate - a.successRate || b.delivered - a.delivered)
        .slice(0, 5);

    // 5. CSR Ranking Board
    const rankingPeriod = filter === 'custom' ? 'month' : filter;
    // Fetch all Sales Officers to ensure they always appear on the board
    const salesOfficers = await prisma.user.findMany({
      where: {
        role: {
          name: 'Sales Officer'
        }
      },
      select: {
        id: true,
        full_name: true,
        username: true,
        image: true,
        outlet: {
          select: {
            name: true
          }
        }
      }
    });

    // Fetch existing rankings for the period
    const rankings = await prisma.csrRanking.findMany({
      where: {
        period: rankingPeriod,
        month: rankingPeriod === 'month' ? now.getMonth() + 1 : 0,
        year: rankingPeriod === 'month' ? now.getFullYear() : 0,
      }
    });

    // Fetch complaints for all CSRs in this period
    const solvedComplaintsGroups = await prisma.complaint.groupBy({
      by: ['assigned_to_user_id'],
      where: {
        status: 'Solved',
        updated_at: { gte: start, lte: end }
      },
      _count: { id: true }
    });

    const pendingComplaintsGroups = await prisma.complaint.groupBy({
      by: ['assigned_to_user_id'],
      where: {
        status: { in: ['Pending', 'In Progress', 'Assigned'] },
        created_at: { lte: end } // All pending up to current period end
      },
      _count: { id: true }
    });

    const complaintsSolvedMap = solvedComplaintsGroups.reduce((acc, c) => {
      acc[c.assigned_to_user_id] = c._count.id;
      return acc;
    }, {});

    const complaintsPendingMap = pendingComplaintsGroups.reduce((acc, c) => {
      acc[c.assigned_to_user_id] = c._count.id;
      return acc;
    }, {});

    // Map rankings by CSR ID for quick lookup
    const rankingMap = rankings.reduce((acc, r) => {
      acc[r.csr_id] = r;
      return acc;
    }, {});

    let csrRanking = salesOfficers.map(officer => {
      const rankRecord = rankingMap[officer.id];
      const isStaleToday = rankingPeriod === 'today' && rankRecord && rankRecord.updated_at < start;
      const useData = rankRecord && !isStaleToday;
      const score = useData ? rankRecord.score : 0;

      // League logic
      let league = 'Bronze';
      if (score >= 1500) league = 'Gold';
      else if (score >= 1000) league = 'Silver';

      console.log(rankRecord)

      return {
        userId: officer.id,
        name: officer.full_name,
        username: officer.username,
        image: officer.image,
        outletName: officer.outlet?.name || 'Main Outlet',
        uniqueCustomers: useData ? rankRecord.unique_customers : 0,
        delivered: useData ? rankRecord.delivered_customers : 0,
        repeatCustomers: useData ? rankRecord.repeat_customers : 0,
        cancelled: useData ? rankRecord.cancelled_customers : 0,
        expired: useData ? rankRecord.expired_customers : 0,
        totalSales: useData ? rankRecord.total_sales : 0,
        score: score,
        trend: useData ? rankRecord.trend : 0,
        league: league,
        complaintsSolved: complaintsSolvedMap[officer.id] || 0,
        complaintsPending: complaintsPendingMap[officer.id] || 0,
        successRate: (useData && rankRecord.unique_customers > 0) ? Math.round((rankRecord.delivered_customers / rankRecord.unique_customers) * 100) : 0,
        cancelRate: (useData && rankRecord.unique_customers > 0) ? Math.round((rankRecord.cancelled_customers / rankRecord.unique_customers) * 100) : 0,
      };
    });

    // Sort by score desc, then total sales desc
    csrRanking.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.totalSales - a.totalSales;
    });

    // Add rank index
    csrRanking = csrRanking.map((r, index) => ({ ...r, rank: index + 1 }));

    return res.status(200).json({
      success: true,
      data: {
        filter,
        dateRange: { start: start, end: end },
        isCsr,
        totalOrders,
        statusCounts: {
          new: newCount,
          pending: pendingCount,
          in_progress: inProgressCount,
          cancelled: cancelledCount,
          completed: completedCount,
          delivered: deliveredCount,
          expired: expiredCount,
          approved: approvedCount,
          picked: pickedCount,
          rejected: rejectedCount,
        },
        todayIncrement,
        channelStats,
        successRate,
        cancelRate,
        targetTracking,
        graphData,
        outletPerformance,
        csrRanking,
      },
    });
  } catch (error) {
    console.error('getCsrDashboardStats error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};



const getExpiredAssignedOrders = async (req, res) => {
  const userRole = (req.user.role || '').toLowerCase();
  const isVerificationOfficer = req.user.role_id === 1 || userRole.includes('verification');

  if (!isVerificationOfficer) {
    return res.status(403).json({ success: false, message: 'Access denied. Verification officers only.' });
  }

  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 20);
  const skip = (page - 1) * limit;

  try {
    const where = {
      assigned_to_user_id: req.user.id,
      status: 'expired',
    };

    const total = await prisma.order.count({ where });
    const orders = await prisma.order.findMany({
      where,
      orderBy: { updated_at: 'desc' },
      skip,
      take: limit,
    });

    return res.json({
      success: true,
      data: {
        orders,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 1,
        },
      },
    });
  } catch (error) {
    console.error('getExpiredAssignedOrders error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getMyDeliveryOrdersWithPagination = async (req, res) => {
  const { lastId = 0, limit = 10, search = '', ...filters } = req.query;

  const take = Number(limit);
  const cursorId = Number(lastId);

  try {
    const baseWhere = {
      delivery_officer_id: req.user.id,
    };

    if (search.trim()) {
      baseWhere.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
        { token_number: { contains: search } },
        { product_name: { contains: search } },
        { city: { contains: search } },
        { area: { contains: search } },
      ];
    }

    // Optional extra filters (agar frontend se bheje ja rahe hon)
    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        if (key === 'status') {
          baseWhere.status = value;
        } else if (key === 'created_by') {
          baseWhere.created_by = { username: value };
        } else if (key !== 'startDate' && key !== 'endDate' && key !== 'nextLastId') {
          baseWhere[key] = { contains: value };
        }
      }
    });

    const totalCount = await prisma.order.count({
      where: baseWhere
    });

    const where = { ...baseWhere };

    const orders = await prisma.order.findMany({
      where,
      take,
      skip: cursorId > 0 ? 1 : 0,
      cursor: cursorId > 0 ? { id: cursorId } : undefined,
      orderBy: [
        { updated_at: 'desc' },
        { id: 'desc' }
      ],
      include: {
        created_by: {
          select: {
            username: true,
            full_name: true,
          },
        },
        assigned_to: {
          select: {
            username: true,
            full_name: true,
          },
        },
        delivery_officer: {
          select: {
            username: true,
            full_name: true,
          },
        },
        verification: {
          select: {
            id: true,
            status: true,
            start_time: true,
            end_time: true,
            home_location_required: true,
            home_location_verified: true,
            location_vo_sent: true,
            location_do_sent: true,
            purchaser: {
              select: {
                id: true,
                name: true,
                father_husband_name: true,
                present_address: true,
                permanent_address: true,
                utility_bill_url: true,
                cnic_number: true,
                cnic_front_url: true,
                cnic_back_url: true,
                telephone_number: true,
                employer_name: true,
                employer_address: true,
                designation: true,
                official_number: true,
                service_card_url: true,
                years_in_company: true,
                gross_salary: true,
                signature_url: true,
                nearest_location: true,
                is_verified: true,
              },
            },
          },
        },
        delivery: true,
      },
    });

    // Map orders to explicitly include timestamp fields and parse JSON in delivery
    const formattedOrders = orders.map(order => {
      // Parse selected_plan if it exists and is a string
      let parsedDelivery = order.delivery;
      if (order.delivery && order.delivery.selected_plan) {
        // Check if selected_plan is a string (JSON) or already an object
        if (typeof order.delivery.selected_plan === 'string') {
          try {
            parsedDelivery = {
              ...order.delivery,
              selected_plan: JSON.parse(order.delivery.selected_plan)
            };
          } catch (e) {
            console.error('Error parsing selected_plan:', e);
            parsedDelivery = order.delivery;
          }
        }
      }

      return {
        ...order,
        delivery: parsedDelivery,
        verification_assigned_at: order.verification_assigned_at,
        delivery_assigned_at: order.delivery_assigned_at,
        recovery_assigned_at: order.recovery_assigned_at
      };
    });

    let nextLastId = null;
    if (orders.length > 0) {
      nextLastId = orders[orders.length - 1].id;
    }

    const hasMore = orders.length === take;

    return res.status(200).json({
      success: true,
      data: {
        orders: formattedOrders,
        pagination: {
          nextLastId,
          hasMore,
          limit: take,
          count: formattedOrders.length,
          totalCount
        },
      },
    });
  } catch (error) {
    console.error('getMyDeliveryOrdersWithPagination error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getOrderById = async (req, res) => {
  const { id } = req.params;

  try {

    // Fetch order and related verification (for purchaser location status)
    const order = await prisma.order.findUnique({
      where: { id: Number(id) },
      include: {
        created_by: { select: { username: true, full_name: true } },
        assigned_to: { select: { username: true, full_name: true } },
        delivery_officer: { select: { username: true, full_name: true, id: true } },
        recovery_officer: { select: { username: true, full_name: true, id: true } },
        productHistories: {
          include: {
            changed_by: { select: { username: true, full_name: true } }
          },
          orderBy: { changed_at: 'desc' }
        },
        statusHistories: {
          include: {
            user: { select: { username: true, full_name: true } }
          },
          orderBy: { created_at: 'desc' }
        },
        verification: {
          include: {
            reviews: {
              include: {
                reviewer: {
                  select: {
                    full_name: true,
                    username: true
                  }
                }
              },
              orderBy: { created_at: 'desc' }
            },
            purchaser: true,
            grantors: true,
            nextOfKin: true,
            documents: true,
            verification_locations: {
              include: {
                photos: true
              }
            }
          }
        },
        dummyCustomer: true
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found' },
      });
    }

    // Attach purchaser location status if available
    let purchaserLocationStatus = null;
    let purchaserLocationVerified = null;
    if (order.verification && order.verification.purchaser) {
      purchaserLocationStatus = order.verification.purchaser.nearest_location || null;
      purchaserLocationVerified = !!order.verification.purchaser.is_verified;
    }

    return res.status(200).json({
      success: true,
      data: {
        order,
        purchaserLocationStatus,
        purchaserLocationVerified
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const assignOrder = async (req, res) => {
  const { id } = req.params;
  const { user_id, action = 'assign' } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(id) },
      include: {
        assigned_to: { select: { username: true, fcm_token: true } },
      },
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (action === 'unassign') {
      if (!order.assigned_to_user_id) {
        return res.status(400).json({ success: false, message: 'Order is not assigned' });
      }

      const updated = await prisma.order.update({
        where: { id: parseInt(id) },
        data: {
          assigned_to_user_id: null,
          verification_assigned_at: null,
          updated_at: new Date(), 
        },
        include: {
          created_by: { select: { username: true } },
          assigned_to: { select: { username: true } },
        },
      });

      return res.status(200).json({
        success: true,
        message: 'Order unassigned successfully',
        data: { order: updated },
      });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'User ID required for assignment' });
    }

    if (order.assigned_to_user_id) {
      return res.status(409).json({ success: false, message: 'Order is already assigned' });
    }

    const user = await prisma.user.findUnique({
      where: { id: parseInt(user_id) },
      include: { role: true },
    });

    if (!user || user.role.name !== 'Verification Officer') {
      return res.status(400).json({ success: false, message: 'Invalid Verification Officer' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: parseInt(id) },
      data: {
        assigned_to_user_id: parseInt(user_id),
        verification_assigned_at: new Date(),
        status: order.status === 'in_progress' ? 'in_progress' : 'pending',
        updated_at: new Date(), 
      },
      include: {
        assigned_to: { select: { id: true, username: true, fcm_token: true } },
        created_by: { select: { username: true } },
      },
    });

    if (req.user.outlet_id) {
      await logOrderStatusChange(updatedOrder.id, 'transferred', updatedOrder.status, req.user);
    } else {
      await logOrderStatusChange(updatedOrder.id, order.status, updatedOrder.status, req.user);
    }

    const io = req.app.get('io');
    await notifyAdmins(
      'Order Assigned',
      `Order ${updatedOrder.order_ref} assigned to ${user.full_name} for verification.`,
      'order_assignment',
      updatedOrder.id,
      io
    );

    if (updatedOrder.outlet_id) {
      await notifyOutlet(
        updatedOrder.outlet_id,
        'Order Assigned',
        `Order ${updatedOrder.order_ref} has been assigned to ${user.full_name} for verification.`,
        'order_assignment',
        updatedOrder.id,
        io
      );
    }
    await sendOrderAssignmentNotification(updatedOrder, updatedOrder.assigned_to, 'verification', io);

    return res.status(200).json({
      success: true,
      message: 'Order assigned successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignBulk = async (req, res) => {
  const { order_ids, user_id, action = 'assign' } = req.body;

  if (!Array.isArray(order_ids) || order_ids.length === 0) {
    return res.status(400).json({ success: false, message: 'order_ids array is required' });
  }

  try {
    if (action === 'unassign') {
      await prisma.order.updateMany({
        where: {
          id: { in: order_ids.map(Number) },
          assigned_to_user_id: { not: null },
        },
        data: {
          assigned_to_user_id: null,
          verification_assigned_at: null,
          updated_at: new Date(),
        },
      });

      return res.status(200).json({
        success: true,
        message: 'Selected orders have been unassigned',
      });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id required for assignment' });
    }

    const user = await prisma.user.findUnique({
      where: { id: parseInt(user_id) },
      include: { role: true },
    });

    if (!user || user.role.name !== 'Verification Officer') {
      return res.status(400).json({ success: false, message: 'Invalid Verification Officer' });
    }

    const verificationEntries = order_ids.map(id => ({
      order_id: parseInt(id),
      verification_officer_id: parseInt(user_id),
      status: 'pending',
      start_time: new Date()
    }));

    await prisma.$transaction([
      // 1. Update orders that are NOT in_progress to 'pending'
      prisma.order.updateMany({
        where: { 
          id: { in: order_ids.map(Number) },
          status: { not: 'in_progress' }
        },
        data: {
          assigned_to_user_id: parseInt(user_id),
          verification_assigned_at: new Date(),
          status: 'pending',
          updated_at: new Date(),
        }
      }),
      // 2. Update orders that ARE in_progress to keep 'in_progress'
      prisma.order.updateMany({
        where: { 
          id: { in: order_ids.map(Number) },
          status: 'in_progress'
        },
        data: {
          assigned_to_user_id: parseInt(user_id),
          verification_assigned_at: new Date(),
          status: 'in_progress',
          updated_at: new Date(),
        }
      }),
      prisma.verification.createMany({
        data: verificationEntries,
        skipDuplicates: true
      })
    ]);


     if (req.user.outlet_id) {
      for (const orderId of order_ids) {
        await logOrderStatusChange(orderId, "transferred", 'pending', req.user);
      }
    } else {
      for (const orderId of order_ids) {
        await logOrderStatusChange(orderId, null , 'pending', req.user);
      }
    }

    // Send notifications for bulk assignment
    const io = req.app.get('io');
    const updatedOrders = await prisma.order.findMany({
      where: { id: { in: order_ids.map(Number) } },
      include: { assigned_to: { select: { id: true, username: true, fcm_token: true } } }
    });

    for (const order of updatedOrders) {
      if (order.assigned_to) {
        await sendOrderAssignmentNotification(order, order.assigned_to, 'verification', io);
      }
    }

    return res.status(200).json({
      success: true,
      message: `${order_ids.length} orders assigned successfully`,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const transferOrder = async (req, res) => {
  const { id } = req.params;
  const { outlet_id, action = 'transfer' } = req.body;                               

  if (action === 'untransfer') {
    try {
      const order = await prisma.order.findUnique({
        where: { id: parseInt(id) }
      });

      if (!order) {
        return res.status(404).json({ success: false, message: 'Order not found' });
      }

      const prevOutletId = order.outlet_id;

      const updatedOrder = await prisma.order.update({
        where: { id: parseInt(id) },
        data: {
          outlet_id: null,
          assigned_to_user_id: null,
          verification_assigned_at: null,
          updated_at: new Date(),
        }
      });

      await logOrderStatusChange(updatedOrder.id, 'transferred', 'untransferred', req.user);

      if (prevOutletId) {
        const io = req.app.get('io');
        await sendOrderUntransferNotification(updatedOrder, prevOutletId, io);
      }

      return res.status(200).json({
        success: true,
        message: 'Order un-transferred successfully',
        data: { order: updatedOrder },
      });
    } catch (error) {
      console.error('untransferOrder error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }

  if (!outlet_id) {
    return res.status(400).json({ success: false, message: 'Outlet ID is required for transfer' });
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(id) },
      include: {
        statusHistories: {
          orderBy: { created_at: 'desc' },
          take: 1
        }
      }
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: parseInt(id) },
      data: {
        outlet_id: parseInt(outlet_id),
        assigned_to_user_id: null,
        verification_assigned_at: null,
        updated_at: new Date(),
      },
      include: {
        outlet: { select: { name: true } }
      }
    });

    const lastHistory = order.statusHistories && order.statusHistories[0];
    const oldStatus = lastHistory && lastHistory.new_status === 'untransferred' ? 'untransferred' : order.status;
    await logOrderStatusChange(updatedOrder.id, oldStatus, 'transferred', req.user);

    const io = req.app.get('io');
    await sendOrderTransferNotification(updatedOrder, parseInt(outlet_id), io);


    return res.status(200).json({
      success: true,
      message: 'Order transferred successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error('transferOrder error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const transferBulk = async (req, res) => {
  const { order_ids, outlet_id, action = 'transfer' } = req.body;

  if (!Array.isArray(order_ids) || order_ids.length === 0) {
    return res.status(400).json({ success: false, message: 'Order IDs array is required' });
  }

  if (action === 'untransfer') {
    try {
      const orders = await prisma.order.findMany({ where: { id: { in: order_ids.map(Number) } }});

      await prisma.order.updateMany({
        where: { id: { in: order_ids.map(Number) } },
        data: {
          outlet_id: null,
          assigned_to_user_id: null,
          verification_assigned_at: null,
          updated_at: new Date(),
        }
      });

      const io = req.app.get('io');
      for (const order of orders) {
        await logOrderStatusChange(order.id, 'transferred', 'untransferred', req.user);
        if (order.outlet_id) {
          await sendOrderUntransferNotification(order, order.outlet_id, io);
        }
      }

      return res.status(200).json({
        success: true,
        message: `${order_ids.length} orders un-transferred successfully`,
      });
    } catch (error) {
      console.error('untransferBulk error:', error);
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }

  if (!outlet_id) {
    return res.status(400).json({ success: false, message: 'Outlet ID is required for transfer' });
  }

  try {
    await prisma.order.updateMany({
      where: { id: { in: order_ids.map(Number) } },
      data: {
        outlet_id: parseInt(outlet_id),
        assigned_to_user_id: null,
        verification_assigned_at: null,
        updated_at: new Date(),
      }
    });

    const io = req.app.get('io');
    const updatedOrders = await prisma.order.findMany({
      where: { id: { in: order_ids.map(Number) } },
      include: {
        statusHistories: {
          orderBy: { created_at: 'desc' },
          take: 1
        }
      }
    });

    for (const order of updatedOrders) {
      const lastHistory = order.statusHistories && order.statusHistories[0];
      const oldStatus = lastHistory && lastHistory.new_status === 'untransferred' ? 'untransferred' : (order.status || 'new');
      await logOrderStatusChange(order.id, oldStatus, 'transferred', req.user);
      await sendOrderTransferNotification(order, parseInt(outlet_id), io);
    }

    return res.status(200).json({
      success: true,
      message: `${order_ids.length} orders transferred successfully`,
    });
  } catch (error) {
    console.error('transferBulk error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getVerificationOrders = async (req, res) => {
  const { page = 1, limit = 10, search = '', sortBy = 'updated_at', sortDir = 'desc', ...filters } = req.query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const where = {
      status: 'completed',
    };

    if (search.trim()) {
      where.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
        { area: { contains: search } },
      ];
    }

    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        if (key === 'assigned_to' || key === 'Verification Officer' || key === 'officer') {
           where.verification = { verification_officer: { username: { contains: value } } };
        } else if (key === 'delivery_officer') {
          where.delivery_officer = { username: { contains: value } };
        } else if (key === 'created_by') {
          where.created_by = { username: { contains: value } };
        } else if (key === 'dateRange') {
          const range = getDateRangeFilter(value, filters.startDate, filters.endDate);
          if (range) where.created_at = range;
        } else if (key !== 'startDate' && key !== 'endDate') {
          where[key] = { contains: value };
        }
      }
    });

    const [orders, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        skip,
        take,
        orderBy: { [sortBy]: sortDir },
        include: {
          created_by: { select: { username: true, full_name: true } },
          assigned_to: { select: { username: true, full_name: true } },
          delivery_officer: { select: { username: true, full_name: true } },
          verification: {
            include: {
              verification_officer: { select: { username: true, full_name: true } }
            }
          }
        },
      }),
      prisma.order.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          page: Number(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNext: skip + take < total,
          hasPrev: Number(page) > 1,
        },
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getApprovedOrders = async (req, res) => {
  const { page = 1, limit = 10, search = '', sortBy = 'updated_at', sortDir = 'desc', ...filters } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const userFromDb = await prisma.user.findUnique({ where: { id: req.user.id } });
    const userRole = (req.user?.role || '').toLowerCase();

    const where = {
      status: { in: ['picked', 'approved'] },
    };

    if (userRole === 'branch user') {
      where.AND = [
        {
          OR: [
            { outlet_id: userFromDb?.outlet_id || -1 },
            { created_by_user_id: req.user.id }
          ]
        }
      ];
    }

    if (userRole === 'sales officer' || userRole.includes('csr')) {
      where.created_by_user_id = req.user.id;
    }

    if (search.trim()) {
      where.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
        { area: { contains: search } },
      ];
    }

    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        if (key === 'assigned_to' || key === 'Verification Officer') {
          where.assigned_to = { username: { contains: value } };
        } else if (key === 'delivery_officer') {
          where.delivery_officer = { username: { contains: value } };
        } else if (key === 'created_by') {
          where.created_by = { username: { contains: value } };
        } else if (key === 'dateRange') {
          const range = getDateRangeFilter(value, filters.startDate, filters.endDate);
          if (range) where.created_at = range;
        } else if (key !== 'startDate' && key !== 'endDate') {
          where[key] = { contains: value };
        }
      }
    });

    const [orders, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        skip,
        take,
        orderBy: { [sortBy]: sortDir },
        include: {
          verification: {
            include: {
              verification_officer: {
                select: { full_name: true, username: true }
              }
            }
          },
          created_by: {
            select: { id: true, full_name: true, username: true }
          },
          assigned_to: {
            select: { id: true, full_name: true, username: true }
          },
          delivery_officer: {
            select: {
              id: true,
              username: true,
              full_name: true
            }
          }
        }
      }),
      prisma.order.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          page: Number(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNext: skip + take < total,
          hasPrev: Number(page) > 1,
        },
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignDelivery = async (req, res) => {
  const { id } = req.params;
  const { user_id, action = 'assign' } = req.body;

  console.log('Assigning delivery with params:', { id, user_id, action });

  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(id) },
      include: { verification: true }
    });


    if (action === 'unassign') {
      const updatedOrder = await prisma.order.update({
        where: { id: Number(id) },
        data: {
          delivery_officer_id: null,
          delivery_assigned_at: null,
          status: 'approved',
          updated_at: new Date(),
        },
        include: {
          delivery_officer: { select: { username: true } }
        }
      });

      await logOrderStatusChange(updatedOrder.id, order.status, 'approved', req.user);

      return res.status(200).json({
        success: true,
        message: 'Delivery officer unassigned successfully',
        data: { order: updatedOrder }
      });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'delivery_officer_id (user_id) required' });
    }

    const officer = await prisma.user.findUnique({
      where: { id: Number(user_id) },
      select: { 
        outlet_id: true,
        full_name: true
       }
    });
    
    console.log('Officer found for delivery assignment:', officer);

    const updatedOrder = await prisma.order.update({
      where: { id: Number(id) },
      data: {
        delivery_officer_id: Number(user_id),
        delivery_assigned_at: new Date(),
        status: 'picked',
        updated_at: new Date(),
      },
      include: {
        delivery_officer: { select: { id: true, username: true, fcm_token: true, full_name: true } }
      }
    });

    await logOrderStatusChange(updatedOrder.id, order.status, 'picked', req.user);

    console.log(officer.full_name);

    const io = req.app.get('io');
    await notifyAdmins(
      'Delivery Assigned',
      `Order ${updatedOrder.order_ref} assigned to ${officer.full_name} for delivery.`,
      'delivery_assignment',
      updatedOrder.id,
      io
    );

    if (updatedOrder.outlet_id) {
      await notifyOutlet(
        updatedOrder.outlet_id,
        'Delivery Assigned',
        `Order ${updatedOrder.order_ref} has been assigned to ${officer.full_name} for delivery.`,
        'delivery_assignment',
        updatedOrder.id,
        io
      );
    }
    if (updatedOrder.delivery_officer) {
      await sendOrderAssignmentNotification(updatedOrder, updatedOrder.delivery_officer, 'delivery', io);
    }

    return res.status(200).json({
      success: true,
      message: 'Delivery officer assigned successfully',
      data: { order: updatedOrder }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignBulkDelivery = async (req, res) => {
  const { order_ids, user_id, action = 'assign' } = req.body;

  if (!Array.isArray(order_ids) || order_ids.length === 0) {
    return res.status(400).json({ success: false, message: 'order_ids required' });
  }

  try {
    if (action === 'unassign') {
      await prisma.order.updateMany({
        where: { id: { in: order_ids.map(Number) } },
        data: {
          delivery_officer_id: null,
          delivery_assigned_at: null,
          status: 'approved',
          updated_at: new Date(),
        }
      });
      for (const orderId of order_ids) {
        await logOrderStatusChange(orderId, null, 'approved', req.user);
      }
      return res.status(200).json({
        success: true,
        message: `${order_ids.length} orders unassigned from delivery`
      });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id required' });
    }

    // Get the officer's outlet ID
    const officer = await prisma.user.findUnique({
      where: { id: Number(user_id) },
      select: { 
        outlet_id: true,
        full_name: true
       }
    });

    await prisma.order.updateMany({
      where: { id: { in: order_ids.map(Number) } },
      data: {
        delivery_officer_id: Number(user_id),
        delivery_assigned_at: new Date(),
        status: 'picked',
        updated_at: new Date(),
      }
    });

    for (const orderId of order_ids) {
      await logOrderStatusChange(orderId, null, 'picked', req.user);
    }

    // Send notifications for bulk delivery assignment
    const io = req.app.get('io');
    const updatedOrders = await prisma.order.findMany({
      where: { id: { in: order_ids.map(Number) } },
      include: { delivery_officer: { select: { id: true, username: true, fcm_token: true, full_name: true } } }
    });

    for (const order of updatedOrders) {
      if (order.delivery_officer) {
        await sendOrderAssignmentNotification(order, order.delivery_officer, 'delivery', io);
      }
    }

    return res.status(200).json({
      success: true,
      message: `${order_ids.length} orders assigned for delivery`
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const cancelOrder = async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(id) },
      select: { status: true }
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const oldStatus = order.status;

    const updatedOrder = await prisma.order.update({
      where: { id: parseInt(id) },
      data: {
        status: 'cancelled',
        cancelled_at: new Date(),
        updated_at: new Date(), 
        cancelled_reason: reason || 'Cancelled by admin',
      },
    });

    await logOrderStatusChange(updatedOrder.id, oldStatus, 'cancelled', req.user);

    if (updatedOrder.outlet_id) {
    await logAction(
      req,
      'ORDER_CANCELLATION',
      `Order ${updatedOrder.order_ref} was cancelled. Reason: ${reason || 'Cancelled by admin'}`,
      updatedOrder.id,
      'Order'
    );
    }

    const io = req.app.get('io');
    await notifyAdmins(
      'Order Cancelled',
      `Order ${updatedOrder.order_ref} has been cancelled. Reason: ${reason || 'Cancelled by admin'}`,
      'order_cancellation',
      updatedOrder.id,
      io
    );

    if (updatedOrder.outlet_id) {
      await notifyOutlet(
        updatedOrder.outlet_id,
        'Order Cancelled',
        `Order ${updatedOrder.order_ref} has been cancelled. Reason: ${reason || 'N/A'}`,
        'order_cancellation',
        updatedOrder.id,
        io
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Order cancelled successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const updateOrderItem = async (req, res) => {
  const { id } = req.params;
  const { product_name, total_amount, advance_amount, monthly_amount, months } = req.body;

  try {
    const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (product_name && product_name !== order.product_name) {
      await prisma.orderProductHistory.create({
        data: {
          order_id: order.id,
          previous_product: order.product_name,
          current_product: product_name,
          changed_by_user_id: req.user.id,
          changed_at: new Date(),
        },
      });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: parseInt(id) },
      data: {
        product_name,
        total_amount: total_amount ? parseFloat(total_amount) : undefined,
        advance_amount: advance_amount ? parseFloat(advance_amount) : undefined,
        monthly_amount: monthly_amount ? parseFloat(monthly_amount) : undefined,
        months: months ? parseInt(months) : undefined,
        updated_at: new Date(),
      },
    });

    if (req.user.outlet_id) {
      await logAction(
        req,
        'ORDER_UPDATE',
        `Order ${updatedOrder.order_ref} details or product name were updated.`,
        updatedOrder.id,
        'Order'
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Order item updated successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error('Update order item error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getDeliveryStatus = async (req, res) => {
  try {
    const userFromDb = await prisma.user.findUnique({ where: { id: req.user.id } });
    const userRole = (req.user?.role || '').toLowerCase();

    const where = {
      status: { in: ['picked', 'in_progress'] },
    };

    if (userRole === 'branch user') {
      where.outlet_id = userFromDb?.outlet_id || -1;
    }

    const orders = await prisma.order.findMany({
      where,
      take: 10,
      orderBy: { updated_at: 'desc' },
      select: {
        id: true,
        order_ref: true,
        customer_name: true,
        address: true,
        status: true,
        total_amount: true,
        updated_at: true,
        delivery_officer: {
          select: { full_name: true, username: true }
        }
      }
    });

    const formatted = orders.map(o => ({
      ...o,
      amount: o.total_amount
    }));

    return res.status(200).json({ success: true, data: formatted });
  } catch (error) {
    console.error('Get delivery status error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getDeliveredOrders = async (req, res) => {
  const { page = 1, limit = 10, search = '', sortBy = 'updated_at', sortDir = 'desc', ...filters } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const userFromDb = await prisma.user.findUnique({ where: { id: req.user.id } });
    const userRole = (req.user?.role || '').toLowerCase();

    const where = {
      status: 'delivered',
    };

    if (userRole === 'branch user') {
      where.AND = [
        {
          OR: [
            { outlet_id: userFromDb?.outlet_id || -1 },
            { created_by_user_id: req.user.id }
          ]
        }
      ];
    }

    if (search.trim()) {
      where.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
        { area: { contains: search } },
      ];
    }

    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        if (key === 'assigned_to' || key === 'Verification Officer') {
          where.assigned_to = { username: { contains: value } };
        } else if (key === 'delivery_officer') {
          where.delivery_officer = { username: { contains: value } };
        } else if (key === 'recovery_officer') {
          where.recovery_officer = { username: { contains: value } };
        } else if (key === 'created_by') {
          where.created_by = { username: { contains: value } };
        } else if (key === 'dateRange') {
          const range = getDateRangeFilter(value, filters.startDate, filters.endDate);
          if (range) where.created_at = range;
        } else if (key !== 'startDate' && key !== 'endDate') {
          where[key] = { contains: value };
        }
      }
    });

    const orders = await prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { [sortBy]: sortDir },
      include: {
        created_by: { select: { username: true } },
        assigned_to: { select: { username: true, full_name: true } },
        delivery_officer: { select: { username: true, full_name: true } },
        recovery_officer: { select: { username: true, full_name: true } },
      },
    });

    const total = await prisma.order.count({ where });
    const totalPages = Math.ceil(total / take);

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          page: Number(page),
          total,
          totalPages,
        },
      },
    });
  } catch (error) {
    console.error('Get delivered orders error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignRecovery = async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;

  try {
    const updatedOrder = await prisma.order.update({
      where: { id: parseInt(id) },
      data: {
        recovery_officer_id: parseInt(user_id),
        recovery_assigned_at: new Date(),
        updated_at: new Date(),
      },
      include: {
        recovery_officer: { select: { id: true, username: true, fcm_token: true, full_name: true } }
      }
    });

    // Send notification
    const io = req.app.get('io');
    if (updatedOrder.recovery_officer) {
      await sendOrderAssignmentNotification(updatedOrder, updatedOrder.recovery_officer, 'recovery', io);
    }

    return res.status(200).json({
      success: true,
      message: 'Recovery officer assigned successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error('Assign recovery error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignBulkRecovery = async (req, res) => {
  const { order_ids, user_id } = req.body;

  try {
    await prisma.order.updateMany({
      where: { id: { in: order_ids.map(Number) } },
      data: {
        recovery_officer_id: parseInt(user_id),
        recovery_assigned_at: new Date(),
        updated_at: new Date(),
      },
    });

    // Send notifications for bulk recovery assignment
    const io = req.app.get('io');
    const updatedOrders = await prisma.order.findMany({
      where: { id: { in: order_ids.map(Number) } },
      include: { recovery_officer: { select: { id: true, username: true, fcm_token: true, full_name: true } } }
    });

    for (const order of updatedOrders) {
      if (order.recovery_officer) {
        await sendOrderAssignmentNotification(order, order.recovery_officer, 'recovery', io);
      }
    }

    return res.status(200).json({
      success: true,
      message: `${order_ids.length} orders assigned for recovery`,
    });
  } catch (error) {
    console.error('Assign bulk recovery error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const initiateHandover = async (req, res) => {
  const { id } = req.params; // Order ID
  const { saveOTP } = require('../utils/otpUtils');
  const axios = require('axios');

  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(id) },
      include: { delivery_officer: true }
    });

    if (!order || order.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Order must be in APPROVED status for handover' });
    }

    if (!order.delivery_officer || !order.delivery_officer.phone) {
      return res.status(400).json({ success: false, message: 'No delivery officer assigned or phone missing' });
    }

    const otp = await saveOTP(order.delivery_officer.phone, 'handover');

    // Send via WATI
    const WATI_BASE_URL = process.env.WATI_BASE_URL;
    const WATI_ACCESS_TOKEN = process.env.WATI_ACCESS_TOKEN;
    const WATI_TEMPLATE_NAME = process.env.WATI_TEMPLATE_NAME;

    if (WATI_BASE_URL && WATI_ACCESS_TOKEN) {
      const url = `${WATI_BASE_URL}/api/v2/sendTemplateMessage?whatsappNumber=+92${order.delivery_officer.phone.slice(1)}`;
      try {
        await axios.post(url, {
          template_name: WATI_TEMPLATE_NAME || 'otp_verification',
          broadcast_name: 'Handover_OTP',
          parameters: [{ name: '1', value: otp }]
        }, {
          headers: {
            Authorization: `Bearer ${WATI_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
      } catch (watiErr) {
        console.error('WATI Error details:', watiErr.response?.data || watiErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Handover OTP initiated',
      otp: process.env.NODE_ENV === 'development' ? otp : undefined
    });
  } catch (error) {
    console.error('initiateHandover error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const verifyHandover = async (req, res) => {
  const { id } = req.params; // Order ID
  const { otp, imei_serial } = req.body;
  const { verifyOTP } = require('../utils/otpUtils');

  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(id) },
      include: { delivery_officer: true }
    });

    if (!order || order.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Order must be in APPROVED status for handover' });
    }

    // Verify OTP
    const otpResult = await verifyOTP(order.delivery_officer.phone, otp, 'handover');
    if (!otpResult.valid) {
      return res.status(400).json({ success: false, message: otpResult.message });
    }

    // Check IMEI in inventory
    const inventoryItem = await prisma.outletInventory.findUnique({
      where: { imei_serial }
    });

    if (!inventoryItem || inventoryItem.status !== 'In Stock') {
      return res.status(400).json({ success: false, message: 'IMEI not found or not in stock' });
    }

    if (inventoryItem.outlet_id !== req.user.outlet_id) {
      return res.status(400).json({ success: false, message: 'This item does not belong to your outlet' });
    }

    // Atomic update
    await prisma.$transaction([
      prisma.order.update({
        where: { id: order.id },
        data: {
          status: 'picked',
          imei_serial: imei_serial,
          updated_at: new Date(),
        }
      }),
      prisma.outletInventory.update({
        where: { id: inventoryItem.id },
        data: { status: 'Sold' },
        updated_at: new Date(),
      }),
      prisma.stockTransfer.create({
        data: {
          from_type: 'Outlet',
          from_id: order.outlet_id || 0,
          to_type: 'Delivery Officer',
          to_id: order.delivery_officer_id || 0,
          inventory_id: inventoryItem.id,
          created_at: new Date(),
          updated_at: new Date(), 
        }
      })
    ]);

    await logOrderStatusChange(order.id, order.status, 'picked', req.user);

    const io = req.app.get('io');
    await notifyAdmins(
      'Stock Handed Over',
      `Order #${order.order_ref} stock (${imei_serial}) has been handed over to ${order.delivery_officer.full_name}.`,
      'stock_transfer',
      order.id,
      io
    );

    if (order.outlet_id) {
      await notifyOutlet(
        order.outlet_id,
        'Stock Handed Over',
        `Stock for Order #${order.order_ref} has been handed over to ${order.delivery_officer.full_name}.`,
        'stock_transfer',
        order.id,
        io
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Stock handover verified and completed'
    });
  } catch (error) {
    console.error('verifyHandover error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getOutletDeliveryOfficers = async (req, res) => {
  try {
    const outlet_id = req.user.outlet_id;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Forbidden: No outlet assigned' });

    const officers = await prisma.user.findMany({
      where: {
        outlet_id: outlet_id,
        role: { name: 'Delivery Agent' },
        status: 'active'
      },
      select: {
        id: true,
        full_name: true,
        username: true,
        phone: true,
        is_online: true,
        image: true
      }
    });

    return res.status(200).json({ success: true, data: officers });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getOfficerApprovedOrders = async (req, res) => {
  const { officerId } = req.params;
  try {
    const orders = await prisma.order.findMany({
      where: {
        delivery_officer_id: Number(officerId),
        status: 'approved',
        outlet_id: req.user.outlet_id
      },
      orderBy: { created_at: 'desc' }
    });

    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getHandoverHistory = async (req, res) => {
  try {
    const outlet_id = req.user.outlet_id;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Forbidden' });

    const transfers = await prisma.stockTransfer.findMany({
      where: {
        from_type: 'Outlet',
        from_id: outlet_id
      },
      include: {
        inventory: {
          select: {
            imei_serial: true,
            product_name: true
          }
        }
      },
      orderBy: { created_at: 'desc' },
      take: 100
    });

    const imeis = transfers.map(t => t.inventory.imei_serial);
    const orders = await prisma.order.findMany({
      where: { imei_serial: { in: imeis } },
      select: {
        imei_serial: true,
        customer_name: true,
        order_ref: true,
        delivery_officer: { select: { full_name: true } }
      }
    });

    const orderMap = new Map(orders.map(o => [o.imei_serial, o]));

    const data = transfers.map(t => ({
      ...t,
      order: orderMap.get(t.inventory.imei_serial) || null
    }));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Self Pickup Helpers (for Branch/Outlet Users)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /orders/self-pickup/inventory
 * Returns In Stock inventory items for the user's outlet (for self-pickup dropdown)
 */
const getSelfPickupInventory = async (req, res) => {
  const { search = '' } = req.query;
  const outlet_id = req.user.outlet_id;

  if (!outlet_id) {
    return res.status(403).json({ success: false, message: 'Not an outlet user.' });
  }

  try {
    const where = {
      outlet_id,
      status: 'In Stock',
      AND: [
        { imei_serial: { not: null } },
        { imei_serial: { not: '' } },
      ]
    };

    if (search.trim()) {
      where.OR = [
        { product_name: { contains: search.trim() } },
        { imei_serial: { contains: search.trim() } },
        { color_variant: { contains: search.trim() } },
      ];
    }

    const inventory = await prisma.outletInventory.findMany({
      where,
      select: {
        id: true,
        product_name: true,
        category: true,
        imei_serial: true,
        color_variant: true,
        purchase_price: true,
        installment_plans: true,
        status: true,
      },
      orderBy: { product_name: 'asc' },
    });

    return res.status(200).json({ success: true, data: inventory });
  } catch (error) {
    console.error('getSelfPickupInventory error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * POST /orders/self-pickup/send-otp
 * Sends OTP to the customer's phone for self-pickup verification
 */
const sendSelfPickupOTP = async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, message: 'phone is required' });
  }

  try {
    const otp = await saveOTP(phone, 'self_pickup');
    await sendOTP(phone, otp);

    return res.status(200).json({ success: true, message: 'OTP sent successfully.' });
  } catch (error) {
    console.error('sendSelfPickupOTP error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * POST /orders/self-pickup/verify-otp
 * Verifies OTP for self-pickup
 */
const verifySelfPickupOTP = async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ success: false, message: 'phone and otp are required' });
  }

  try {
    const result = await verifyOTP(phone, otp, 'self_pickup');

    if (!result.valid) {
      return res.status(400).json({ success: false, message: result.message || 'Invalid OTP' });
    }

    return res.status(200).json({ success: true, message: 'OTP verified successfully.' });
  } catch (error) {
    console.error('verifySelfPickupOTP error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * POST /orders/convert/send-otp
 * Sends OTP to a specific phone number for conversion verification
 */
const sendIndividualConvertOTP = async (req, res) => {
  const { phone, name, type } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, message: 'Phone number is required' });
  }

  try {
    const otp = await saveOTP(phone, 'convert_sale');
    
    if (type === 'grantor' && name) {
        // Use the specialized grantor template if name is provided
        const template_name = process.env.WATI_GRANTORS_OTP_TEMPLATE_NAME;
        const broadcast_name = process.env.WATI_GRANTORS_OTP_BROADCAST_NAME;
        
        if (template_name && broadcast_name) {
            await sendTemplate(phone, template_name, broadcast_name, [
                { name: '1', value: otp },
                { name: 'name', value: name }
            ]);
            console.log(  "OTP sent to " + phone + "Name" + name + " with template " + template_name + " and broadcast " + broadcast_name);
        } else {
            await sendOTP(phone, otp);
        }
    } else {
        await sendOTP(phone, otp);
    }

    return res.status(200).json({ success: true, message: `OTP sent to ${phone}` });
  } catch (error) {
    console.error('sendIndividualConvertOTP error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * POST /orders/convert/verify-otp
 */
const verifyConvertSaleOTP = async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ success: false, message: 'phone and otp are required' });
  }

  try {
    const result = await verifyOTP(phone, otp, 'convert_sale');

    if (!result.valid) {
      return res.status(400).json({ success: false, message: result.message || 'Invalid OTP' });
    }

    return res.status(200).json({ success: true, message: 'OTP verified successfully.' });
  } catch (error) {
    console.error('verifyConvertSaleOTP error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * POST /orders/convert/create
 * Creates a fast-tracked order from a cleared account
 */
const createConvertedSale = async (req, res) => {
  const {
    orderData,
    purchaserData,
    grantorsData,
    otpVerified
  } = req.body;

  if (!otpVerified) {
    return res.status(400).json({ success: false, message: 'OTP must be verified first.' });
  }

  try {
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    
    // Generate references
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const order_ref = `QIST-${dateStr}-${randomNum}`;
    const token_number = crypto.randomBytes(4).toString('hex').toUpperCase();

    // The new order starts as 'completed'
    const status = 'completed';

    const newOrder = await prisma.order.create({
      data: {
        order_ref,
        token_number,
        customer_name: purchaserData.name || orderData.customer_name,
        whatsapp_number: purchaserData.telephone_number || orderData.whatsapp_number,
        alternate_contact: orderData.alternate_contact || null,
        address: purchaserData.present_address || orderData.address,
        city: orderData.city || 'Karachi',
        area: orderData.area || null,
        zone: orderData.zone || null,
        block: orderData.block || null,
        street: orderData.street || null,
        house_no: orderData.house_no || null,
        order_notes: 'Repeat Customer Sale',
        
        gender: orderData.gender || null,
        marital_status: orderData.marital_status || null,
        residential_type: orderData.residential_type || null,

        product_name: orderData.product_name,
        total_amount: parseFloat(orderData.total_amount),
        advance_amount: parseFloat(orderData.advance_amount),
        monthly_amount: parseFloat(orderData.monthly_amount),
        months: parseInt(orderData.months),
        channel: orderData.channel || 'Repeat Customer',
        status: status,
        created_at: new Date(),
        updated_at: new Date(),
        created_by_user_id: req.user.id,
        outlet_id: orderData.outlet_id || currentUser?.outlet_id || null,
        is_repeat_customer: true
      }
    });

    // Link customer for ranking
    try {
        await getOrCreateCustomer(newOrder.id);
        await updateCsrRanking(req.user.id, 'month');
        await updateCsrRanking(req.user.id, 'today');
    } catch (rankingError) {
        console.error('Ranking update failed in conversion:', rankingError);
    }

    // Fetch old verification to clone documents and locations
    const { oldOrderId } = req.body;
    let oldVerification = null;
    if (oldOrderId) {
        oldVerification = await prisma.verification.findUnique({
            where: { order_id: Number(oldOrderId) },
            include: { documents: true, verification_locations: { include: { photos: true } } }
        });
    }

    // Create Verification and nested records
    const { id: _, verification_id: __, ...cleanPurchaserData } = purchaserData;
    
    const verification = await prisma.verification.create({
      data: {
        order_id: newOrder.id,
        verification_officer_id: req.user.id,
        status: 'completed',
        start_time: new Date(),
        end_time: new Date(),
        created_at: new Date(),
        updated_at: new Date(), 
        verification_feedback: 'Repeat customer converted sale.',
        purchaser: {
          create: {
            ...cleanPurchaserData,
            is_verified: true
          }
        },
        grantors: {
          create: grantorsData.map((g, idx) => {
            const { id: gId, verification_id: gVid, ...cleanG } = g;
            return {
              ...cleanG,
              grantor_number: idx + 1,
              is_verified: true
            };
          })
        },
        // Clone documents if they exist
        documents: oldVerification?.documents ? {
            create: oldVerification.documents.map(doc => {
                const { id: dId,  verification_id: dVid, uploaded_at: dAt, ...cleanDoc } = doc;
                return cleanDoc;
            })
        } : undefined,
        // Clone locations if they exist
        verification_locations: oldVerification?.verification_locations ? {
            create: oldVerification.verification_locations.map(loc => {
                const { id: lId, verification_id: lVid, created_at: lAt, photos: lPhotos, ...cleanLoc } = loc;
                return {
                    ...cleanLoc,
                    photos: {
                        create: lPhotos?.map(p => {
                            const { id: pId, verification_location_id: pLid, uploaded_at: pAt, ...cleanP } = p;
                            return cleanP;
                        })
                    }
                };
            })
        } : undefined
      }
    });

    // Inject status history for all steps
    const historySteps = [
      { old: null, new: 'new' },
      { old: 'new', new: 'pending' },
      { old: 'pending', new: 'in_progress' },
      { old: 'in_progress', new: 'completed' }
    ];

    for (const step of historySteps) {
      await logOrderStatusChange(newOrder.id, step.old, step.new, req.user, 'Repeat Customer Sale', true);
    }

    // Send a single custom message for repeat customers
    if (newOrder.whatsapp_number) {
        const repeatMsg = `Mohtaram Customer, aapka Repeat Customer order ${newOrder.order_ref} approve hone ke liye bhej diya gaya hai. Qist Market muntakhib karne ka shukriya!`;
        await sendOrderStatusNotification(newOrder.whatsapp_number, { 
            customerName: newOrder.customer_name, 
            message: repeatMsg 
        });
    }

    // Emit Socket.IO and send Dashboard Notifications
    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('new_order', newOrder);
      if (newOrder.outlet_id) {
        io.to(`outlet_${newOrder.outlet_id}`).emit('new_order', newOrder);
      }
    }

    // Dashboard Notifications
    const notificationTitle = 'Repeat Customer Sale';
    const notificationMessage = `New repeat sale ${newOrder.order_ref} created for ${newOrder.customer_name}.`;
    
    await notifyAdmins(notificationTitle, notificationMessage, 'order_creation', newOrder.id, io);
    if (newOrder.outlet_id) {
        await notifyOutlet(newOrder.outlet_id, notificationTitle, notificationMessage, 'order_creation', newOrder.id, io);
    }

    return res.status(201).json({
      success: true,
      message: 'New sale created successfully from repeat customer.',
      data: { orderId: newOrder.id, token: newOrder.token_number }
    });

  } catch (error) {
    console.error('createConvertedSale error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  createOrder,
  getOrders,
  getOrdersWithPagination,
  getMyDeliveryOrdersWithPagination,
  assignOrder,
  assignBulk,
  getOrderById,
  getVerificationOrders,
  getApprovedOrders,
  assignDelivery,
  assignBulkDelivery,
  cancelOrder,
  initiateHandover,
  verifyHandover,
  updateOrderItem,
  takeOrder,
  getCsrDashboardStats,
  getExpiredAssignedOrders,
  getDeliveryStatus,
  getDeliveredOrders,
  assignRecovery,
  assignBulkRecovery,
  getOutletDeliveryOfficers,
  getOfficerApprovedOrders,
  getHandoverHistory,
  expireOrders,
  sendOrderAssignmentNotification,
  createOrderFromWebsitePickup,
  getWebsiteOrderFeed,
  cancelWebsiteOrderFeedItem,
  transferOrder,
  transferBulk,
  getSelfPickupInventory,
  sendSelfPickupOTP,
  verifySelfPickupOTP,
  sendIndividualConvertOTP,
  verifyConvertSaleOTP,
  createConvertedSale,
};
