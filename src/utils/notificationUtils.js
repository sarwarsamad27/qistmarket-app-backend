const prisma = require('../../lib/prisma');

// Helper for current timestamp
const now = () => new Date();

/**
 * Notify all active admins
 */
const notifyAdmins = async (title, message, type, relatedId = null, io = null) => {
    try {
        const admins = await prisma.user.findMany({
            where: {
                role_id: { in: [4, 6, 7, 9] },
                status: 'active'
            },
            select: { id: true }
        });

        if (admins.length === 0) return;

        const notificationData = admins.map(admin => ({
            userId: admin.id,
            title,
            message,
            type,
            relatedId: relatedId ? parseInt(relatedId) : null,
            createdAt: now(),   // ✅ explicit
            updatedAt: now()    // ✅ explicit
        }));

        await prisma.notification.createMany({ data: notificationData });

        if (io) {
            io.to('admins').emit('new_notification', {
                id: Date.now(), // Unique key for UI
                title,
                message,
                type,
                relatedId,
                isRead: false,
                createdAt: now(),
                updatedAt: now()
            });
        }
    } catch (err) {
        console.error('Failed to notify admins:', err);
    }
};

/**
 * Notify a specific user
 */
const notifyUser = async (userId, title, message, type, relatedId = null, io = null) => {
    try {
        const notification = await prisma.notification.create({
            data: {
                userId: parseInt(userId),
                title,
                message,
                type,
                relatedId: relatedId ? parseInt(relatedId) : null,
                createdAt: now(),   // ✅ explicit
                updatedAt: now()    // ✅ explicit
            }
        });

        if (io) {
            io.to(`user_${userId}`).emit('new_notification', {
                id: notification.id,
                title,
                message,
                type,
                relatedId,
                isRead: false,
                createdAt: notification.createdAt,
                updatedAt: notification.updatedAt
            });
        }
    } catch (err) {
        console.error(`Failed to notify user ${userId}:`, err);
    }
};

/**
 * Notify all users in a specific outlet
 */
const notifyOutlet = async (outletId, title, message, type, relatedId = null, io = null) => {
    try {
        const users = await prisma.user.findMany({
            where: {
                outlet_id: parseInt(outletId),
                status: 'active',
                role_id: { in: [5, 8] } // Branch User and Sales Officer
            },
            select: { id: true }
        });

        if (users.length === 0) return;

        const notificationData = users.map(user => ({
            userId: user.id,
            title,
            message,
            type,
            relatedId: relatedId ? parseInt(relatedId) : null,
            createdAt: now(),   // ✅ explicit
            updatedAt: now()    // ✅ explicit
        }));

        await prisma.notification.createMany({ data: notificationData });

        if (io) {
            io.to(`outlet_${outletId}`).emit('new_notification', {
                id: Date.now(), // Unique key for UI
                title,
                message,
                type,
                relatedId,
                isRead: false,
                createdAt: now(),
                updatedAt: now()
            });
        }
    } catch (err) {
        console.error(`Failed to notify outlet ${outletId}:`, err);
    }
};

module.exports = {
    notifyAdmins,
    notifyUser,
    notifyOutlet
};