const prisma = require('../../lib/prisma');

// Helper for current timestamp
const now = () => new Date();

const getNotifications = async (req, res) => {
    const { page = 1, limit = 10, status = 'all' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where = { userId: req.user.id };
    if (status === 'read') where.isRead = true;
    else if (status === 'unread') where.isRead = false;

    try {
        const notifications = await prisma.notification.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take,
        });

        const total = await prisma.notification.count({
            where,
        });

        const unreadCount = await prisma.notification.count({
            where: { userId: req.user.id, isRead: false },
        });

        return res.status(200).json({
            success: true,
            data: {
                notifications,
                unreadCount,
                pagination: {
                    page: Number(page),
                    limit: take,
                    total,
                    totalPages: Math.ceil(total / take),
                },
            },
        });
    } catch (error) {
        console.error('getNotifications error:', error);
        return res.status(500).json({
            success: false,
            error: { code: 500, message: 'Internal server error' },
        });
    }
};

const markAsRead = async (req, res) => {
    const { id } = req.params;

    try {
        const notification = await prisma.notification.findUnique({
            where: { id: Number(id) },
        });

        if (!notification) {
            return res.status(404).json({
                success: false,
                message: 'Notification not found',
            });
        }

        if (notification.userId !== req.user.id) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized',
            });
        }

        const updated = await prisma.notification.update({
            where: { id: Number(id) },
            data: {
                isRead: true,
                updatedAt: now(),   // ✅ explicit updatedAt
            },
        });

        return res.status(200).json({
            success: true,
            message: 'Notification marked as read',
            data: updated,
        });
    } catch (error) {
        console.error('markAsRead error:', error);
        return res.status(500).json({
            success: false,
            error: { code: 500, message: 'Internal server error' },
        });
    }
};

const markAllAsRead = async (req, res) => {
    try {
        await prisma.notification.updateMany({
            where: { userId: req.user.id, isRead: false },
            data: {
                isRead: true,
                updatedAt: now(),   // ✅ explicit updatedAt
            },
        });

        return res.status(200).json({
            success: true,
            message: 'All notifications marked as read',
        });
    } catch (error) {
        console.error('markAllAsRead error:', error);
        return res.status(500).json({
            success: false,
            error: { code: 500, message: 'Internal server error' },
        });
    }
};

module.exports = {
    getNotifications,
    markAsRead,
    markAllAsRead,
};