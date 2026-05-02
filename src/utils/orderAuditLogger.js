const prisma = require('../../lib/prisma');
const { getPKTDate } = require("../utils/dateUtils");

/**
 * Logs a status change for an order.
 * 
 * @param {number} order_id The ID of the order being changed
 * @param {string|null} old_status The previous status
 * @param {string} new_status The new status
 * @param {object} user The user object making the change (req.user)
 */
async function logOrderStatusChange(order_id, old_status, new_status, user) {
  try {
    if (old_status === new_status) return;

    await prisma.orderStatusHistory.create({
      data: {
        order_id: parseInt(order_id),
        old_status: old_status || null,
        new_status: new_status,
        user_id: user?.id ? parseInt(user.id) : null,
        role_name: user?.role || user?.role_name || null,
        created_at: getPKTDate(new Date()),
      }
    });
  } catch (error) {
    console.error('Failed to log order status change:', error);
    // Don't throw so it doesn't break the main flow
  }
}

module.exports = {
  logOrderStatusChange
};
