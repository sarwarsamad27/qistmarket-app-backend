const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const crypto = require('crypto');
const prisma = require('../../lib/prisma');

const generateEmployeeCode = async () => {
  const year = new Date().getFullYear();
  const prefix = `QMK-${year}-`;
  const last = await prisma.employee.findFirst({
    where: { employee_id: { startsWith: prefix } },
    orderBy: { employee_id: 'desc' },
  });
  let seq = 1;
  if (last) {
    const parts = last.employee_id.split('-');
    seq = parseInt(parts[2], 10) + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
};

const generateUsername = (fullName, employeeCode) => {
  const parts = fullName.toLowerCase().trim().split(/\s+/);
  if (parts.length >= 2) {
    const base = `${parts[0]}.${parts[parts.length - 1]}`.replace(/[^a-z0-9.]/g, '');
    return base || employeeCode.toLowerCase();
  }
  return employeeCode.toLowerCase();
};

const generatePassword = () => {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
};

const hashPassword = async (password) => bcrypt.hash(password, 10);

const generateQrDataUrl = async (employeeCode) => {
  return QRCode.toDataURL(employeeCode, { width: 256, margin: 2 });
};

const ensureUniqueUsername = async (baseUsername) => {
  let username = baseUsername;
  let counter = 1;
  while (await prisma.employee.findUnique({ where: { username } })) {
    username = `${baseUsername}${counter}`;
    counter++;
  }
  return username;
};

module.exports = {
  generateEmployeeCode,
  generateUsername,
  generatePassword,
  hashPassword,
  generateQrDataUrl,
  ensureUniqueUsername,
};
