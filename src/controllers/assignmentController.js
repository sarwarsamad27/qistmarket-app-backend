const prisma = require('../../lib/prisma');

// Helper for current timestamp
const now = () => new Date();

const getOfficerAssignments = async (req, res) => {
    const { role } = req.query;
    try {
        let roleName;
        if (role === 'delivery') {
            roleName = 'Delivery Agent';
        } else if (role === 'recovery') {
            roleName = 'Recovery Officer';
        } else {
            roleName = 'Verification Officer';
        }
        const userRole = (req.user?.role || '').toLowerCase();
        const where = { role: { name: roleName } };

        // If it's a branch user, only show officers from their outlet
        if (userRole === 'branch user' && req.user.outlet_id) {
            where.outlet_id = req.user.outlet_id;
        } else if (req.query.outlet_id) {
            // Support explicit filtering if provided (for admins)
            where.outlet_id = parseInt(req.query.outlet_id);
        }

        const officers = await prisma.user.findMany({
            where,
            select: {
                id: true,
                full_name: true,
                username: true,
                officerAssignments: true,
            },
            orderBy: { full_name: 'asc' },
        });

        return res.json({ success: true, data: officers });
    } catch (error) {
        console.error('getOfficerAssignments error:', error);
        return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
};

const updateOfficerAssignments = async (req, res) => {
    const { officerId } = req.params;
    const { assignments } = req.body; // Array of { zone, area }

    try {
        // Delete existing assignments for this officer
        await prisma.officerAreaAssignment.deleteMany({
            where: { user_id: parseInt(officerId) }
        });

        // Create new assignments with explicit timestamps
        if (assignments && assignments.length > 0) {
            await prisma.officerAreaAssignment.createMany({
                data: assignments.map(a => ({
                    user_id: parseInt(officerId),
                    zone: a.zone,
                    area: a.area,
                    createdAt: now(),   // ✅ explicit createdAt
                    updatedAt: now()    // ✅ explicit updatedAt
                }))
            });
        }

        return res.json({ success: true, message: 'Assignments updated successfully' });
    } catch (error) {
        console.error('updateOfficerAssignments error:', error);
        return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
};

module.exports = {
    getOfficerAssignments,
    updateOfficerAssignments,
};