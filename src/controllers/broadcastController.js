const { notifyUser, notifyOutlet, notifyRole, notifyAll } = require('../utils/notificationUtils');
const prisma = require('../../lib/prisma');

/**
 * sendBroadcast
 * Single compose endpoint over the existing notifyUser/notifyOutlet/notifyRole/
 * notifyAll utils — each already writes Notification rows and, given an io
 * instance, pushes live via the Socket.IO rooms every client already joins
 * on connect (index.js:147-165). No new schema, no new push mechanism.
 */
const sendBroadcast = async (req, res) => {
    const role = (req.user?.role || '').toLowerCase();
    if (role !== 'admin' && role !== 'super admin') {
        return res.status(403).json({ success: false, message: 'Only Admin or Super Admin can send broadcasts.' });
    }

    const { target, targetId, title, message } = req.body;

    if (!target || !title || !message) {
        return res.status(400).json({ success: false, message: 'target, title, and message are required.' });
    }

    try {
        const io = req.app.get('io');

        if (target === 'all') {
            await notifyAll(title, message, 'broadcast', null, io);
        } else if (target === 'role') {
            if (!targetId) return res.status(400).json({ success: false, message: 'targetId (role name) is required for target=role.' });
            await notifyRole(targetId, title, message, 'broadcast', null, io);
        } else if (target === 'outlet') {
            if (!targetId) return res.status(400).json({ success: false, message: 'targetId (outlet id) is required for target=outlet.' });
            await notifyOutlet(parseInt(targetId), title, message, 'broadcast', null, io);
        } else if (target === 'user') {
            if (!targetId) return res.status(400).json({ success: false, message: 'targetId (user id) is required for target=user.' });
            await notifyUser(parseInt(targetId), title, message, 'broadcast', null, io);
        } else {
            return res.status(400).json({ success: false, message: "target must be one of 'all', 'role', 'outlet', 'user'." });
        }

        res.json({ success: true, message: 'Broadcast sent.' });
    } catch (error) {
        console.error('sendBroadcast error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getRoleOptions
 * Small helper for the broadcast compose form's role picker.
 */
const getRoleOptions = async (req, res) => {
    try {
        const roles = await prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
        res.json({ success: true, data: roles });
    } catch (error) {
        console.error('getRoleOptions error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = { sendBroadcast, getRoleOptions };
