const prisma = require('../../lib/prisma');
const { getPKTDate } = require("../utils/dateUtils");
const { sendOrderStatusNotification } = require('../services/watiService');
const { updateCsrRanking } = require('../services/rankingService');

/**
 * Logs a status change for an order and sends a WhatsApp notification via Wati.
 * 
 * @param {number} order_id The ID of the order being changed
 * @param {string|null} old_status The previous status
 * @param {string} new_status The new status
 * @param {object} user The user object making the change (req.user)
 * @param {string|null} remarks Optional remarks for the audit trail
 */
async function logOrderStatusChange(order_id, old_status, new_status, user, remarks = null, skipNotification = false) {
  try {
    if (old_status === new_status && !remarks) return;

    // Fetch order details with necessary relations for the message and audit
    const freshOrder = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      select: {
        id: true,
        whatsapp_number: true,
        customer_name: true,
        order_ref: true,
        cancelled_reason: true,
        postponed_feedback: true,
        assigned_to: { select: { full_name: true } },
        delivery_officer: { select: { full_name: true } },
        recovery_officer: { select: { full_name: true } },
        outlet: { select: { name: true } }
      }
    });

    if (!freshOrder) return;

    // Auto-generate remarks if not provided
    let finalRemarks = remarks;
    if (!finalRemarks) {
      if (new_status.toLowerCase() === 'transferred' && freshOrder.outlet) {
        finalRemarks = `Transferred to ${freshOrder.outlet.name}`;
      } else if (new_status.toLowerCase() === 'pending' && freshOrder.assigned_to) {
        finalRemarks = `Assigned to ${freshOrder.assigned_to.full_name} for Verification`;
      } else if (new_status.toLowerCase() === 'picked' && freshOrder.delivery_officer) {
        finalRemarks = `Assigned to ${freshOrder.delivery_officer.full_name} for Delivery`;
      }
    }

    await prisma.orderStatusHistory.create({
      data: {
        order_id: parseInt(order_id),
        old_status: old_status || null,
        new_status: new_status,
        user_id: user?.id ? parseInt(user.id) : null,
        role_name: user?.role || user?.role_name || null,
        remarks: finalRemarks,
        created_at: getPKTDate(new Date()),
      }
    });

    // ─── Wati Notification Logic ─────────────────────────────────────────────
    
    if (skipNotification || !freshOrder.whatsapp_number) return;

    let message = "";
    const customerName = freshOrder.customer_name;
    const orderRef = freshOrder.order_ref;

    switch (new_status.toLowerCase()) {
      case 'new':
        message = `Aapka order ${orderRef} kamyabi se create ho chuka hai. Hum jald hi isay process karenge. Qist Market muntakhib karne ka shukriya!`;
        break;

      case 'pending':
        if (freshOrder.assigned_to) {
          message = `Aapka order ${orderRef} hamare Verification Officer ${freshOrder.assigned_to.full_name} ko assign kar diya gaya hai. Woh jald hi aapse mazeed maloomat ke liye raabta karenge.`;
        }
        break;

      case 'in_progress':
        if (freshOrder.assigned_to) {
          message = `Aapke order ${orderRef} ki verification shuru ho chuki hai. Hamare officer ${freshOrder.assigned_to.full_name} aapki maloomat ka jaiza le rahe hain.`;
        }
        break;

      case 'transferred':
        if (freshOrder.outlet) {
          message = `Aapka order ${orderRef} mazeed processing ke liye hamare ${freshOrder.outlet.name} outlet ko transfer kar diya gaya hai.`;
        }
        break;

      case 'picked':
        if (freshOrder.delivery_officer) {
          message = `Aapka order ${orderRef} Delivery Officer ${freshOrder.delivery_officer.full_name} ko assign kar diya gaya hai. Aapko aapka product jald mil jayega!`;
        }
        break;

      case 'approved':
        message = `Mubarak ho! Aapka order ${orderRef} approve ho chuka hai. Isay jald hi delivery ke liye assign kar diya jayega.`;
        break;

      case 'completed':
        message = `Mubarak ho! Aapke order ${orderRef} ki verification kamyabi se mukammal ho chuki hai. Ab yeh aage ki processing ke liye bhej diya gaya hai.`;
        break;

      case 'delivered':
        message = `Aapka order ${orderRef} kamyabi se deliver ho chuka hai. Umeed hai aapko aapki kharidari pasand aayegi! Qist Market ka shukriya.`;
        break;

      case 'cancelled':
        message = `Aapka order ${orderRef} cancel kar diya gaya hai. Wajah: ${freshOrder.cancelled_reason || 'N/A'}. Agar aapka koi sawal hai to hamari support team se raabta karein.`;
        break;

      case 'postponed':
        message = `Aapka order ${orderRef} postpone kar diya gaya hai. Wajah: ${freshOrder.postponed_feedback || 'N/A'}. Hum isay baad mein process karenge.`;
        break;

      case 'expired':
        message = `Aapka order ${orderRef} expire ho chuka hai. Agar aap isay dubara khulwana chahte hain to hamari website visit karein ya support se raabta karein.`;
        break;

      default:
        // No message for unknown statuses
        break;
    }

    if (message) {
      // Send notification asynchronously without waiting
      sendOrderStatusNotification(freshOrder.whatsapp_number, {
        customerName: `Assalam-o-Alaikum ${customerName}!`,
        message: message
      }).catch(err => console.error('[WATI] Notification Error:', err));
    }

    // Trigger CSR Ranking Update on specific status changes that affect scores
    if (['delivered', 'completed', 'cancelled', 'expired'].includes(new_status.toLowerCase())) {
        const orderForRanking = await prisma.order.findUnique({
            where: { id: parseInt(order_id) },
            select: { created_by_user_id: true }
        });
        if (orderForRanking?.created_by_user_id) {
            updateCsrRanking(orderForRanking.created_by_user_id, 'month').catch(err => console.error('Ranking update error:', err));
            updateCsrRanking(orderForRanking.created_by_user_id, 'today').catch(err => console.error('Ranking update error:', err));
        }
    }

  } catch (error) {
    console.error('Failed to log order status change or send notification:', error);
  }
}

module.exports = {
  logOrderStatusChange
};
