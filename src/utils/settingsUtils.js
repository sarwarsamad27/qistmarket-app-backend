const prisma = require('../../lib/prisma');

// Helper for current timestamp
const now = () => new Date();

const getOutletSettings = async (outletId) => {
    try {
        const outlet = await prisma.outlet.findUnique({
            where: { id: parseInt(outletId) },
            select: { auto_assignment_config: true }
        });

        if (outlet && outlet.auto_assignment_config) {
            // Prisma might return it as an object or string depending on setup
            const config = outlet.auto_assignment_config;
            return typeof config === 'string' ? JSON.parse(config) : config;
        }

        return {
            verification: false,
            delivery: false,
            recovery: false
        };
    } catch (err) {
        console.error('Error fetching outlet settings from DB:', err);
        return {
            verification: false,
            delivery: false,
            recovery: false
        };
    }
};

const saveOutletSettings = async (outletId, newSettings) => {
    try {
        const currentSettings = await getOutletSettings(outletId);
        const updatedSettings = {
            ...currentSettings,
            ...newSettings
        };

        await prisma.outlet.update({
            where: { id: parseInt(outletId) },
            data: {
                auto_assignment_config: updatedSettings,
                updated_at: now()   // ✅ explicit updated_at
            }
        });
        return true;
    } catch (err) {
        console.error('Error saving outlet settings to DB:', err);
        return false;
    }
};

module.exports = {
    getOutletSettings,
    saveOutletSettings
};