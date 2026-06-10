const prisma = require('../../lib/prisma');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { jwtSecret } = require('../config/jwtConfig');

const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const employeeLogin = async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ success: false, message: 'Employee ID/username and password are required.' });
  }

  try {
    const id = identifier.trim();
    const employee = await prisma.employee.findFirst({
      where: {
        OR: [
          { employee_id: id },
          { username: id.toLowerCase() },
        ],
      },
      include: { login_attempts: true, outlet: true },
    });

    if (!employee) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    if (!employee.portal_active || employee.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Portal access is inactive. Contact HR.' });
    }

    const attempt = employee.login_attempts;
    if (attempt?.locked_until && new Date(attempt.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(attempt.locked_until) - new Date()) / 60000);
      return res.status(429).json({
        success: false,
        message: `Account locked. Try again in ${mins} minute(s).`,
      });
    }

    const valid = await bcrypt.compare(password, employee.password_hash);
    if (!valid) {
      const failed = (attempt?.failed_attempts || 0) + 1;
      const data = {
        failed_attempts: failed,
        locked_until: failed >= LOCKOUT_ATTEMPTS
          ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
          : null,
      };
      await prisma.employeeLoginAttempt.upsert({
        where: { employee_id: employee.id },
        create: { employee_id: employee.id, ...data },
        update: data,
      });
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    if (attempt) {
      await prisma.employeeLoginAttempt.update({
        where: { employee_id: employee.id },
        data: { failed_attempts: 0, locked_until: null },
      });
    }

    const payload = {
      id: employee.id,
      employee_id: employee.employee_id,
      full_name: employee.full_name,
      username: employee.username,
      department: employee.department,
      designation: employee.designation,
      outlet_id: employee.outlet_id,
      outlet_name: employee.outlet?.name || null,
      role: 'employee',
      type: 'employee',
    };

    const token = jwt.sign(payload, jwtSecret, { expiresIn: '7d' });
    return res.json({ success: true, token, user: payload });
  } catch (error) {
    console.error('employeeLogin error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getEmployeeMe = async (req, res) => {
  try {
    const employee = await prisma.employee.findUnique({
      where: { id: req.employee.id },
      include: { outlet: true },
    });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }
    const { password_hash, ...safe } = employee;
    return res.json({ success: true, employee: safe });
  } catch (error) {
    console.error('getEmployeeMe error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = { employeeLogin, getEmployeeMe };
