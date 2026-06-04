const prisma = require('../../lib/prisma');

// Helper for current timestamp
const now = () => new Date();

const getCashRegister = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const registers = await prisma.cashRegister.findMany({
            where: { outlet_id },
            orderBy: { date: 'desc' }
        });
        res.json({ success: true, registers });
    } catch (error) {
        console.error('getCashRegister error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const calculateDailyCash = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Find today's register or create a new one
        let register = await prisma.cashRegister.findUnique({
            where: {
                outlet_id_date: {
                    outlet_id,
                    date: today
                }
            }
        });

        if (!register) {
            register = await prisma.cashRegister.create({
                data: {
                    outlet_id,
                    date: today,
                    opening_cash: 0, // Ideally fetch yesterday's closing
                    created_at: now(),   // ✅ explicit created_at
                    updated_at: now()    // ✅ explicit updated_at
                }
            });
        }

        res.json({ success: true, register });

    } catch (error) {
        console.error('calculateDailyCash error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getCashRegister,
    calculateDailyCash
};