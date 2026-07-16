const prisma = require('../../lib/prisma');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/jwtConfig');
const { logLoginAction } = require('../utils/auditLogger');

const accountantLogin = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  try {
    const accountantRole = await prisma.role.findFirst({ where: { name: 'Accountant' } });
    if (!accountantRole) {
      return res.status(404).json({ success: false, message: 'Accountant role is not configured.' });
    }

    const user = await prisma.user.findFirst({
      where: { username: username.toLowerCase().trim(), role_id: accountantRole.id },
      include: { role: true },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Accountant account not found.' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is not active.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash || '');
    if (!isMatch) {
      await logLoginAction(req, user, 'failed', 'Incorrect password.');
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const payload = {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      username: user.username,
      phone: user.phone,
      role_id: user.role_id,
      role: user.role.name,
      outlet_id: user.outlet_id,
    };

    const token = jwt.sign(payload, jwtSecret);
    await logLoginAction(req, user, 'success');

    return res.json({ success: true, message: 'Accountant login successful.', token, user: payload });
  } catch (error) {
    console.error('accountantLogin error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = { accountantLogin };
