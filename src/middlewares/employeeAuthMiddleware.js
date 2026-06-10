const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/jwtConfig');
const prisma = require('../../lib/prisma');

const authenticateEmployeeJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authorization required.' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, jwtSecret);
    if (decoded.type !== 'employee' || !decoded.id) {
      return res.status(403).json({ success: false, message: 'Invalid employee token.' });
    }
    req.employee = decoded;
    next();
  } catch {
    return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
  }
};

const requireHRAdmin = async (req, res, next) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    const allowed = ['admin', 'super admin', 'hr'];
    if (!allowed.includes(role)) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        include: { role: true },
      });
      const dbRole = (user?.role?.name || '').toLowerCase();
      if (!allowed.includes(dbRole)) {
        return res.status(403).json({ success: false, message: 'HR Admin access required.' });
      }
    }
    next();
  } catch (error) {
    console.error('requireHRAdmin error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = { authenticateEmployeeJWT, requireHRAdmin };
