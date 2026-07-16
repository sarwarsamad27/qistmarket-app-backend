const prisma = require('../../lib/prisma');
const { getOutletFilter } = require('../utils/outletFilter');

const getSecurityLogs = async (req, res) => {
    try {
        const { action, userId, search, startDate, endDate, page = 1, limit = 20 } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const take = parseInt(limit);

        const where = {
            ...getOutletFilter(req)
        };

        if (action) {
            where.action = action;
        }

        if (userId) {
            where.user_id = parseInt(userId);
        }

        if (search) {
            where.OR = [
                { details: { contains: search } },
                { user_name: { contains: search } },
            ];
        }

        if (startDate || endDate) {
            where.created_at = {};
            if (startDate) where.created_at.gte = new Date(startDate);
            if (endDate) where.created_at.lte = new Date(endDate);
        }

        const logs = await prisma.securityLog.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip,
            take,
            include: {
                user: {
                    select: {
                        username: true,
                        full_name: true,
                        image: true
                    }
                },
                outlet: {
                    select: {
                        name: true,
                        code: true
                    }
                }
            }
        });

        const total = await prisma.securityLog.count({ where });

        res.status(200).json({
            success: true,
            logs,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get Security Logs Error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = { getSecurityLogs };
