const prisma = require('../../lib/prisma');

// Helper for current timestamp
const now = () => new Date();

/**
 * Log a security action for an outlet
 * @param {Object} req - Express request object (contains req.user)
 * @param {string} action - Action slug (e.g. STOCK_ADDITION)
 * @param {string} details - Human readable description
 * @param {number|null} targetId - ID of affected entity
 * @param {string|null} targetType - Type of affected entity
 */
const logAction = async (req, action, details, targetId = null, targetType = null) => {
    try {
        if (!req.user) return;

        await prisma.securityLog.create({
            data: {
                outlet_id: req.user.outlet_id,
                user_id: req.user.id,
                user_name: req.user.full_name || req.user.username,
                action: action,
                details: details,
                target_id: targetId ? parseInt(targetId) : null,
                target_type: targetType,
                created_at: now()   // ✅ explicit created_at
            }
        });
    } catch (error) {
        console.error('Audit Logger Error:', error);
    }
};

module.exports = { logAction };