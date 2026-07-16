const prisma = require('../../lib/prisma');

const requireAccountant = async (req, res, next) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    const allowed = ['accountant', 'super admin'];
    if (!allowed.includes(role)) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        include: { role: true },
      });
      const dbRole = (user?.role?.name || '').toLowerCase();
      if (!allowed.includes(dbRole)) {
        return res.status(403).json({ success: false, message: 'Accountant access required.' });
      }
    }
    next();
  } catch (error) {
    console.error('requireAccountant error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = { requireAccountant };
