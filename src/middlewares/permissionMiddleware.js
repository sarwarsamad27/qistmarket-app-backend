/**
 * requirePermission(key)
 * Fail-open by design: an absent/unset permission key means "allowed" —
 * today's behavior for every existing account, unchanged. A permission
 * only blocks once a Super Admin has explicitly set it to false for that
 * specific user via PATCH /api/admin-panel/users/:id/permissions. Super
 * Admin itself always passes, regardless of what's set.
 */
const requirePermission = (key) => (req, res, next) => {
    const role = (req.user?.role || '').toLowerCase();
    if (role === 'super admin') return next();

    const permissions = req.user?.permissions;
    if (permissions && permissions[key] === false) {
        return res.status(403).json({ success: false, message: `You do not have permission to perform this action (${key}).` });
    }

    next();
};

module.exports = { requirePermission };
