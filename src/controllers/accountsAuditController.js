const prisma = require('../../lib/prisma');
const { getOutletFilter } = require('../utils/outletFilter');

/**
 * getLoginHistory
 * Thin, purpose-built view over SecurityLog's LOGIN_SUCCESS/LOGIN_FAILED
 * rows (written by logLoginAction from every login flow — Web OTP, Outlet,
 * HR, Accountant) — same underlying table as the general Activity Log,
 * filtered to just login events with IP/device columns front and center.
 */
const getLoginHistory = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { userId, status, page = 1, limit = 25 } = req.query;

    try {
        const where = {
            ...outletFilter,
            action: status === 'failed' ? 'LOGIN_FAILED' : status === 'success' ? 'LOGIN_SUCCESS' : { in: ['LOGIN_SUCCESS', 'LOGIN_FAILED'] },
        };
        if (userId) where.user_id = parseInt(userId);

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [logs, total] = await Promise.all([
            prisma.securityLog.findMany({
                where,
                include: { user: { select: { full_name: true, username: true } }, outlet: { select: { name: true } } },
                orderBy: { created_at: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.securityLog.count({ where }),
        ]);

        res.json({ success: true, data: logs, pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / limit) } });
    } catch (error) {
        console.error('getLoginHistory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getFraudAlerts
 * Rule-based fraud signals computed from existing data — not a black-box
 * ML system, but three concrete, explainable checks an accountant can act on:
 *  1. Repeated failed logins for one account in the last 24h
 *  2. A CNIC repeatedly flipped between blacklist/whitelist (possible collusion)
 *  3. Cash-in-hand pending far longer than normal (>72h unsubmitted)
 */
const getFraudAlerts = async (req, res) => {
    try {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);

        const [failedLogins, blacklistFlips, stalePendingCash] = await Promise.all([
            prisma.securityLog.groupBy({
                by: ['user_id', 'user_name'],
                where: { action: 'LOGIN_FAILED', created_at: { gte: oneDayAgo } },
                _count: { id: true },
                having: { id: { _count: { gte: 3 } } },
            }),
            prisma.blacklistAction.groupBy({
                by: ['cnic'],
                where: { created_at: { gte: sevenDaysAgo } },
                _count: { id: true },
                having: { id: { _count: { gte: 3 } } },
            }),
            prisma.cashInHand.findMany({
                where: { status: 'pending', created_at: { lte: seventyTwoHoursAgo } },
                include: { officer: { select: { full_name: true } }, outlet: { select: { name: true } } },
                orderBy: { created_at: 'asc' },
                take: 50,
            }),
        ]);

        const alerts = [
            ...failedLogins.map((f) => ({
                severity: 'warning', type: 'repeated_failed_login',
                title: `${f._count.id} failed login attempts`,
                message: `${f.user_name} had ${f._count.id} failed login attempts in the last 24 hours.`,
            })),
            ...blacklistFlips.map((b) => ({
                severity: 'serious', type: 'blacklist_flip',
                title: `CNIC flagged ${b._count.id} times this week`,
                message: `CNIC ${b.cnic} has been blacklisted/whitelisted ${b._count.id} times in the last 7 days — review for possible collusion.`,
            })),
            ...stalePendingCash.map((c) => ({
                severity: 'warning', type: 'stale_pending_cash',
                title: `Cash pending ${Math.floor((Date.now() - new Date(c.created_at)) / 3600000)}h`,
                message: `PKR ${c.amount - (c.submitted_amount || 0)} collected by ${c.officer?.full_name || 'Unknown'} at ${c.outlet?.name || 'Unassigned'} still not submitted.`,
            })),
        ];

        res.json({ success: true, data: { count: alerts.length, alerts } });
    } catch (error) {
        console.error('getFraudAlerts error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getLoginHistory,
    getFraudAlerts,
};
