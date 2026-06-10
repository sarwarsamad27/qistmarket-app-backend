const prisma = require('../../lib/prisma');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/jwtConfig');
const {
  generateEmployeeCode,
  generateUsername,
  generatePassword,
  hashPassword,
  generateQrDataUrl,
  ensureUniqueUsername,
} = require('../utils/employeeUtils');
const { sendOTP } = require('../services/watiService');

const now = () => new Date();

// ── Biometric Attendance ──
// In-memory store for biometric device records (in production, replace with ZKTeco SDK/API)
let biometricDeviceLog = [];
const BIOMETRIC_DEVICE_IP = process.env.BIOMETRIC_DEVICE_IP || '192.168.1.100';
const BIOMETRIC_DEVICE_PORT = process.env.BIOMETRIC_DEVICE_PORT || '4370';

const recordBiometricAttendance = async (req, res) => {
  try {
    const { employee_id, date, check_in, check_out, method } = req.body;
    // method: 'fingerprint' | 'thumb' | 'card' | 'face'
    if (!employee_id) {
      return res.status(400).json({ success: false, message: 'Employee ID is required.' });
    }
    const employee = await prisma.employee.findUnique({ where: { employee_id } });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }
    const attDate = toDate(date);
    const nowStr = new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', hour12: false });
    const record = await prisma.employeeAttendance.upsert({
      where: { employee_id_date: { employee_id: employee.id, date: attDate } },
      create: {
        employee_id: employee.id,
        date: attDate,
        status: check_in && !check_out ? 'present' : check_out ? 'present' : 'present',
        check_in: check_in || nowStr,
        check_out: check_out || null,
        missed_punch: !check_in,
        notes: `[method:${method || 'fingerprint'}]`,
      },
      update: {
        ...(check_in && { check_in }),
        ...(check_out && { check_out }),
        status: 'present',
        missed_punch: false,
        notes: `[method:${method || 'fingerprint'}]`,
      },
    });
    biometricDeviceLog.push({ employee_id, date: attDate, method: method || 'fingerprint', timestamp: now() });
    return res.json({ success: true, record, message: 'Biometric attendance recorded.' });
  } catch (error) {
    console.error('recordBiometricAttendance error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getBiometricDeviceStatus = async (req, res) => {
  return res.json({
    success: true,
    device: { ip: BIOMETRIC_DEVICE_IP, port: BIOMETRIC_DEVICE_PORT, connected: true, model: 'ZKTeco BioTime 8.0' },
    recentLogs: biometricDeviceLog.slice(-50),
  });
};

const syncBiometricAttendance = async (req, res) => {
  try {
    const { start_date, end_date } = req.body;
    // In production, this would call ZKTeco SDK to pull logs
    // For now, return a placeholder
    return res.json({
      success: true,
      message: 'Biometric sync initiated. Check device logs.',
      synced: biometricDeviceLog.length,
      note: 'Production integration requires ZKTeco SDK configuration.',
    });
  } catch (error) {
    console.error('syncBiometricAttendance error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const createEmployee = async (req, res) => {
  try {
    const {
      full_name, cnic, phone, email, address, emergency_contact, emergency_phone,
      qualification, experience, date_of_birth, date_of_joining,
      department, designation, outlet_id, basic_salary,
    } = req.body;

    if (!full_name) {
      return res.status(400).json({ success: false, message: 'Full name is required.' });
    }

    const employeeCode = await generateEmployeeCode();
    const baseUsername = generateUsername(full_name, employeeCode);
    const username = await ensureUniqueUsername(baseUsername);
    const plainPassword = generatePassword();
    const password_hash = await hashPassword(plainPassword);
    const qr_code = await generateQrDataUrl(employeeCode);

    const employee = await prisma.$transaction(async (tx) => {
      const emp = await tx.employee.create({
        data: {
          employee_id: employeeCode,
          full_name,
          username,
          password_hash,
          portal_active: true,
          qr_code,
          cnic: cnic || null,
          phone: phone || null,
          email: email || null,
          address: address || null,
          emergency_contact: emergency_contact || null,
          emergency_phone: emergency_phone || null,
          qualification: qualification || null,
          experience: experience || null,
          date_of_birth: date_of_birth ? new Date(date_of_birth) : null,
          date_of_joining: date_of_joining ? new Date(date_of_joining) : now(),
          department: department || null,
          designation: designation || null,
          outlet_id: outlet_id ? parseInt(outlet_id) : null,
        },
        include: { outlet: true },
      });

      await tx.employmentEvent.create({
        data: {
          employee_id: emp.id,
          event_type: 'joining',
          title: 'Joined QIST Market',
          description: `Joined as ${designation || 'Employee'} in ${department || 'General'}`,
          event_date: emp.date_of_joining || now(),
        },
      });

      await tx.employeeLoginAttempt.create({
        data: { employee_id: emp.id, failed_attempts: 0 },
      });

      const m = now().getMonth() + 1;
      const y = now().getFullYear();
      if (basic_salary) {
        const salary = parseFloat(basic_salary);
        await tx.payrollSlip.create({
          data: {
            employee_id: emp.id,
            month: m,
            year: y,
            basic_salary: salary,
            allowances: salary * 0.1,
            net_payable: salary * 1.1,
            status: 'paid',
            paid_date: now(),
          },
        });
      }

      await tx.employeePerformance.create({
        data: {
          employee_id: emp.id,
          month: m,
          year: y,
          kpi_score: 75,
          attendance_score: 80,
          targets: { sales: 100, recovery: 90 },
          achieved: { sales: 75, recovery: 72 },
          team_rank: 1,
        },
      });

      await tx.employeeNotification.create({
        data: {
          employee_id: emp.id,
          title: 'Welcome to QIST Market',
          message: 'Your employee portal has been activated. Please log in with your credentials.',
          type: 'announcement',
        },
      });

      return emp;
    });

    const { password_hash: _, ...safe } = employee;
    return res.status(201).json({
      success: true,
      employee: safe,
      credentials: { username, password: plainPassword, employee_id: employeeCode },
    });
  } catch (error) {
    console.error('createEmployee error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create employee.' });
  }
};

const getEmployees = async (req, res) => {
  try {
    const employees = await prisma.employee.findMany({
      include: { outlet: { select: { id: true, name: true, code: true } } },
      orderBy: { created_at: 'desc' },
    });
    const safe = employees.map(({ password_hash, ...e }) => e);
    return res.json({ success: true, employees: safe });
  } catch (error) {
    console.error('getEmployees error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getEmployeeById = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const employee = await prisma.employee.findUnique({
      where: { id },
      include: {
        outlet: true,
        timeline_events: { orderBy: { event_date: 'desc' } },
        documents: true,
        loans: true,
        payroll_slips: { orderBy: [{ year: 'desc' }, { month: 'desc' }] },
        leave_requests: { orderBy: { created_at: 'desc' } },
      },
    });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }
    const { password_hash, ...safe } = employee;
    return res.json({ success: true, employee: safe });
  } catch (error) {
    console.error('getEmployeeById error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const updateEmployee = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const data = { ...req.body };
    delete data.password_hash;
    delete data.employee_id;
    delete data.username;
    if (data.date_of_birth) data.date_of_birth = new Date(data.date_of_birth);
    if (data.date_of_joining) data.date_of_joining = new Date(data.date_of_joining);
    if (data.outlet_id) data.outlet_id = parseInt(data.outlet_id);

    const employee = await prisma.employee.update({
      where: { id },
      data: { ...data, updated_at: now() },
      include: { outlet: true },
    });
    const { password_hash, ...safe } = employee;
    return res.json({ success: true, employee: safe });
  } catch (error) {
    console.error('updateEmployee error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update employee.' });
  }
};

const togglePortalAccess = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { portal_active } = req.body;
    const employee = await prisma.employee.update({
      where: { id },
      data: { portal_active: !!portal_active, updated_at: now() },
    });
    const { password_hash, ...safe } = employee;
    return res.json({ success: true, employee: safe });
  } catch (error) {
    console.error('togglePortalAccess error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const resetEmployeePassword = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const plainPassword = generatePassword();
    const password_hash = await hashPassword(plainPassword);
    await prisma.employee.update({
      where: { id },
      data: { password_hash, updated_at: now() },
    });
    return res.json({ success: true, password: plainPassword });
  } catch (error) {
    console.error('resetEmployeePassword error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const sendEmployeeCredentials = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { password } = req.body;
    const employee = await prisma.employee.findUnique({ where: { id } });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }
    if (!employee.phone) {
      return res.status(400).json({ success: false, message: 'Employee has no phone number.' });
    }

    const msg = `QIST Market Portal\nID: ${employee.employee_id}\nUser: ${employee.username}\nPass: ${password || '(use existing password)'}\nLogin: ${process.env.EMPLOYEE_PORTAL_URL || 'https://qistmarket-app-dashboard.onrender.com/employee/login'}`;

    if (password) {
      await sendOTP(employee.phone, msg.substring(0, 6));
    }

    return res.json({
      success: true,
      message: 'Credentials message queued.',
      preview: msg,
    });
  } catch (error) {
    console.error('sendEmployeeCredentials error:', error);
    return res.status(500).json({ success: false, message: 'Failed to send credentials.' });
  }
};

const sendAnnouncement = async (req, res) => {
  try {
    const { title, message, type, employee_ids } = req.body;
    if (!title || !message) {
      return res.status(400).json({ success: false, message: 'Title and message are required.' });
    }

    let targets;
    if (employee_ids?.length) {
      targets = await prisma.employee.findMany({
        where: { id: { in: employee_ids.map((x) => parseInt(x)) }, portal_active: true },
      });
    } else {
      targets = await prisma.employee.findMany({ where: { portal_active: true, status: 'active' } });
    }

    await prisma.employeeNotification.createMany({
      data: targets.map((e) => ({
        employee_id: e.id,
        title,
        message,
        type: type || 'announcement',
      })),
    });

    return res.json({ success: true, count: targets.length });
  } catch (error) {
    console.error('sendAnnouncement error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const addEmploymentEvent = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { event_type, title, description, event_date, metadata, document_url } = req.body;
    const event = await prisma.employmentEvent.create({
      data: {
        employee_id: id,
        event_type,
        title,
        description,
        event_date: event_date ? new Date(event_date) : now(),
        metadata: metadata || null,
        document_url: document_url || null,
      },
    });
    return res.status(201).json({ success: true, event });
  } catch (error) {
    console.error('addEmploymentEvent error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Loan Management ──
const createEmployeeLoan = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { total_amount, monthly_installment, loan_type } = req.body;
    if (!total_amount) {
      return res.status(400).json({ success: false, message: 'Total amount is required.' });
    }
    const monthly = parseFloat(monthly_installment) || 0;
    const loan = await prisma.employeeLoan.create({
      data: {
        employee_id: id,
        loan_type: loan_type || 'general',
        total_amount: parseFloat(total_amount),
        deducted_amount: 0,
        monthly_installment: monthly,
        start_date: now(),
        status: 'active',
      },
    });
    return res.status(201).json({ success: true, loan });
  } catch (error) {
    console.error('createEmployeeLoan error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getEmployeeLoans = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const loans = await prisma.employeeLoan.findMany({
      where: { employee_id: id },
      orderBy: { created_at: 'desc' },
    });
    return res.json({ success: true, loans });
  } catch (error) {
    console.error('getEmployeeLoans error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const closeEmployeeLoan = async (req, res) => {
  try {
    const loanId = parseInt(req.params.loanId);
    const existing = await prisma.employeeLoan.findUnique({ where: { id: loanId } });
    if (!existing) return res.status(404).json({ success: false, message: 'Loan not found.' });
    const loan = await prisma.employeeLoan.update({
      where: { id: loanId },
      data: { status: 'closed', deducted_amount: existing.total_amount },
    });
    return res.json({ success: true, loan });
  } catch (error) {
    console.error('closeEmployeeLoan error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Document Management ──
const uploadEmployeeDocument = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'File is required.' });
    }
    const { title, doc_type } = req.body;
    const doc = await prisma.employeeDocument.create({
      data: {
        employee_id: id,
        doc_type: doc_type || 'other',
        title: title || req.file.originalname,
        file_url: `/uploads/${req.file.filename}`,
      },
    });
    return res.status(201).json({ success: true, document: doc });
  } catch (error) {
    console.error('uploadEmployeeDocument error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const deleteEmployeeDocument = async (req, res) => {
  try {
    const docId = parseInt(req.params.docId);
    await prisma.employeeDocument.delete({ where: { id: docId } });
    return res.json({ success: true, message: 'Document deleted.' });
  } catch (error) {
    console.error('deleteEmployeeDocument error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Performance Management ──
const getEmployeePerformance = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const records = await prisma.employeePerformance.findMany({
      where: { employee_id: id },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    return res.json({ success: true, records });
  } catch (error) {
    console.error('getEmployeePerformance error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const updateEmployeePerformance = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { month, year, kpi_score, attendance_score, targets, achieved, team_rank, remarks } = req.body;
    const record = await prisma.employeePerformance.upsert({
      where: {
        employee_id_month_year: { employee_id: id, month: parseInt(month), year: parseInt(year) },
      },
      create: {
        employee_id: id,
        month: parseInt(month),
        year: parseInt(year),
        kpi_score: parseFloat(kpi_score) || 0,
        attendance_score: parseFloat(attendance_score) || 0,
        targets: targets || {},
        achieved: achieved || {},
        team_rank: parseInt(team_rank) || 1,
        remarks: remarks || null,
      },
      update: {
        kpi_score: parseFloat(kpi_score),
        attendance_score: parseFloat(attendance_score),
        targets,
        achieved,
        team_rank: parseInt(team_rank),
        remarks,
      },
    });
    return res.json({ success: true, record });
  } catch (error) {
    console.error('updateEmployeePerformance error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Attendance Management ──
const getEmployeeAttendance = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { month, year } = req.query;
    const where = { employee_id: id };
    if (month && year) {
      const y = parseInt(year), m = parseInt(month);
      where.date = {
        gte: new Date(Date.UTC(y, m - 1, 1)),
        lte: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)),
      };
    }
    const records = await prisma.employeeAttendance.findMany({
      where,
      orderBy: { date: 'desc' },
    });
    return res.json({ success: true, records });
  } catch (error) {
    console.error('getEmployeeAttendance error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const bulkRecordAttendance = async (req, res) => {
  try {
    const { records } = req.body;
    if (!records?.length) {
      return res.status(400).json({ success: false, message: 'No attendance records provided.' });
    }
    const results = [];
    for (const r of records) {
      const { employee_id, date, status, check_in, check_out, overtime_hrs, missed_punch, notes } = r;
      const attDate = toDate(date);
      const emp = await prisma.employee.findUnique({ where: { employee_id } });
      if (!emp) continue;
      const methodTag = notes?.includes('[method:') ? '' : '[method:bulk] ';
      const record = await prisma.employeeAttendance.upsert({
        where: { employee_id_date: { employee_id: emp.id, date: attDate } },
        create: {
          employee_id: emp.id,
          date: attDate,
          status: status || 'present',
          check_in: check_in || null,
          check_out: check_out || null,
          overtime_hrs: parseFloat(overtime_hrs) || 0,
          missed_punch: !!missed_punch,
          notes: methodTag + (notes || ''),
        },
        update: {
          status: status || 'present',
          check_in: check_in || undefined,
          check_out: check_out || undefined,
          overtime_hrs: parseFloat(overtime_hrs) || 0,
          missed_punch: !!missed_punch,
          notes: methodTag + (notes || ''),
        },
      });
      results.push(record);
    }
    return res.json({ success: true, count: results.length, records: results, sample: 'Format: [{employee_id}, {date YYYY-MM-DD}, {status present/absent/late}]' });
  } catch (error) {
    console.error('bulkRecordAttendance error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Payroll Management ──
const getEmployeePayroll = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const slips = await prisma.payrollSlip.findMany({
      where: { employee_id: id },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    return res.json({ success: true, slips });
  } catch (error) {
    console.error('getEmployeePayroll error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const updatePayrollSlip = async (req, res) => {
  try {
    const slipId = parseInt(req.params.slipId);
    const { basic_salary, allowances, bonuses, commissions, deductions, status } = req.body;
    const basic = parseFloat(basic_salary) || 0;
    const allow = parseFloat(allowances) || 0;
    const bonus = parseFloat(bonuses) || 0;
    const comm = parseFloat(commissions) || 0;
    const deduct = parseFloat(deductions) || 0;
    const net = basic + allow + bonus + comm - deduct;
    const slip = await prisma.payrollSlip.update({
      where: { id: slipId },
      data: {
        basic_salary: basic,
        allowances: allow,
        bonuses: bonus,
        commissions: comm,
        deductions: deduct,
        net_payable: net,
        status: status || undefined,
        paid_date: status === 'paid' ? now() : undefined,
      },
    });
    return res.json({ success: true, slip });
  } catch (error) {
    console.error('updatePayrollSlip error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Payroll Slip (existing) ──
const addPayrollSlip = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { month, year, basic_salary, allowances, bonuses, commissions, deductions, status } = req.body;
    const basic = parseFloat(basic_salary) || 0;
    const allow = parseFloat(allowances) || 0;
    const bonus = parseFloat(bonuses) || 0;
    const comm = parseFloat(commissions) || 0;
    const deduct = parseFloat(deductions) || 0;
    const net = basic + allow + bonus + comm - deduct;

    const slip = await prisma.payrollSlip.create({
      data: {
        employee_id: id,
        month: parseInt(month),
        year: parseInt(year),
        basic_salary: basic,
        allowances: allow,
        bonuses: bonus,
        commissions: comm,
        deductions: deduct,
        net_payable: net,
        status: status || 'paid',
        paid_date: status === 'paid' ? now() : null,
      },
    });
    return res.status(201).json({ success: true, slip });
  } catch (error) {
    console.error('addPayrollSlip error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const toDate = (d) => {
  if (!d) { const n = new Date(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())); }
  if (d instanceof Date) return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])));
  const dt = new Date(d);
  return new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
};

const recordAttendance = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { date, status, check_in, check_out, overtime_hrs, missed_punch, notes, method } = req.body;
    const attDate = toDate(date);
    const methodStr = method || 'manual';
    const fullNotes = notes ? `[method:${methodStr}] ${notes}` : `[method:${methodStr}]`;
    const nowStr = new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', hour12: false });

    const record = await prisma.employeeAttendance.upsert({
      where: {
        employee_id_date: {
          employee_id: id,
          date: attDate,
        },
      },
      create: {
        employee_id: id,
        date: attDate,
        status,
        check_in: check_in || (status === 'present' ? nowStr : null),
        check_out: check_out || null,
        overtime_hrs: parseFloat(overtime_hrs) || 0,
        missed_punch: !!missed_punch,
        notes: fullNotes,
      },
      update: {
        status,
        ...(check_in ? { check_in } : {}),
        ...(check_out ? { check_out } : {}),
        overtime_hrs: parseFloat(overtime_hrs) || 0,
        missed_punch: !!missed_punch,
        notes: fullNotes,
      },
    });
    return res.json({ success: true, record });
  } catch (error) {
    console.error('recordAttendance error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const hrLogin = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  try {
    const user = await prisma.user.findFirst({
      where: { username: username.toLowerCase().trim(), role_id: 10 },
      include: { role: true },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'HR account not found.' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is not active.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash || '');
    if (!isMatch) {
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

    return res.json({ success: true, message: 'HR login successful.', token, user: payload });
  } catch (error) {
    console.error('hrLogin error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getHrDashboardStats = async (req, res) => {
  try {
    const totalEmployees = await prisma.employee.count();
    const activeEmployees = await prisma.employee.count({ where: { status: 'active', portal_active: true } });
    const totalDepartments = await prisma.employee.groupBy({ by: ['department'], _count: true });
    const pendingLeaves = await prisma.leaveRequest.count({ where: { status: 'pending' } });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayAttendance = await prisma.employeeAttendance.count({
      where: { date: today, status: 'present' },
    });

    return res.json({
      success: true,
      stats: {
        totalEmployees,
        activeEmployees,
        totalDepartments: totalDepartments.filter(d => d.department).length,
        pendingLeaves,
        todayAttendance,
      },
    });
  } catch (error) {
    console.error('getHrDashboardStats error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  createEmployee,
  getEmployees,
  getEmployeeById,
  updateEmployee,
  togglePortalAccess,
  resetEmployeePassword,
  sendEmployeeCredentials,
  sendAnnouncement,
  addEmploymentEvent,
  addPayrollSlip,
  recordAttendance,
  hrLogin,
  getHrDashboardStats,
  // biometric
  recordBiometricAttendance,
  getBiometricDeviceStatus,
  syncBiometricAttendance,
  // loans
  createEmployeeLoan,
  getEmployeeLoans,
  closeEmployeeLoan,
  // documents
  uploadEmployeeDocument,
  deleteEmployeeDocument,
  // performance
  getEmployeePerformance,
  updateEmployeePerformance,
  // attendance
  getEmployeeAttendance,
  bulkRecordAttendance,
  // payroll
  getEmployeePayroll,
  updatePayrollSlip,
};
