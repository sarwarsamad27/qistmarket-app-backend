const prisma = require('../../lib/prisma');

// Helper for current timestamp
const now = () => new Date();

const getClientIp = (req) => (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '').toString().split(',')[0].trim();
const getDeviceInfo = (req) => req.headers['user-agent'] || null;

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
                ip_address: getClientIp(req),
                device_info: getDeviceInfo(req),
                created_at: now()   // ✅ explicit created_at
            }
        });
    } catch (error) {
        console.error('Audit Logger Error:', error);
    }
};

/**
 * Log a login attempt. Separate from logAction because login handlers run
 * BEFORE authenticateJWT populates req.user — the resolved user record is
 * passed in directly instead.
 * @param {Object} req - Express request object
 * @param {Object} user - The resolved user row { id, full_name, username, outlet_id }
 * @param {"success"|"failed"} status
 * @param {string} [reason] - Failure reason, if any
 */
const logLoginAction = async (req, user, status, reason = '') => {
    try {
        if (!user?.id) return;

        await prisma.securityLog.create({
            data: {
                outlet_id: user.outlet_id ?? null,
                user_id: user.id,
                user_name: user.full_name || user.username,
                action: status === 'success' ? 'LOGIN_SUCCESS' : 'LOGIN_FAILED',
                details: status === 'success' ? `${user.username} logged in successfully.` : `Failed login attempt for ${user.username}. ${reason}`,
                target_id: null,
                target_type: 'Login',
                ip_address: getClientIp(req),
                device_info: getDeviceInfo(req),
                created_at: now(),
            },
        });
    } catch (error) {
        console.error('Audit Logger (login) Error:', error);
    }
};

module.exports = { logAction, logLoginAction, getClientIp, getDeviceInfo };
