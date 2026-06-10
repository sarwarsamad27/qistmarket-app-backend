const prisma = require('../../lib/prisma');

const now = () => new Date();

const toDate = (d) => {
  if (!d) { const n = new Date(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())); }
  if (d instanceof Date) return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])));
  const dt = new Date(d);
  return new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
};

const getDashboard = async (req, res) => {
  try {
    const eid = req.employee.id;
    const todayDate = toDate(new Date());

    const [employee, todayAttendance, lastSalary, activeLoan, unreadCount, performance] = await Promise.all([
      prisma.employee.findUnique({ where: { id: eid } }),
      prisma.employeeAttendance.findUnique({
        where: { employee_id_date: { employee_id: eid, date: todayDate } },
      }),
      prisma.payrollSlip.findFirst({
        where: { employee_id: eid, status: 'paid' },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      }),
      prisma.employeeLoan.findFirst({
        where: { employee_id: eid, status: 'active' },
        orderBy: { created_at: 'desc' },
      }),
      prisma.employeeNotification.count({ where: { employee_id: eid, is_read: false } }),
      prisma.employeePerformance.findFirst({
        where: { employee_id: eid, month: now().getMonth() + 1, year: now().getFullYear() },
      }),
    ]);

    const leaveBalance =
      (employee.annual_leave_total - employee.annual_leave_used) +
      (employee.sick_leave_total - employee.sick_leave_used);

    return res.json({
      success: true,
      dashboard: {
        attendance_today: todayAttendance?.status || 'absent',
        leave_balance: leaveBalance,
        last_salary: lastSalary
          ? { amount: lastSalary.net_payable, date: lastSalary.paid_date, month: lastSalary.month, year: lastSalary.year }
          : null,
        loan_balance: activeLoan
          ? { remaining: activeLoan.total_amount - activeLoan.deducted_amount, type: activeLoan.loan_type }
          : null,
        unread_notifications: unreadCount,
        performance_score: performance?.kpi_score || 0,
      },
    });
  } catch (error) {
    console.error('getDashboard error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getProfile = async (req, res) => {
  try {
    const employee = await prisma.employee.findUnique({
      where: { id: req.employee.id },
      include: { outlet: true, documents: true },
    });
    if (!employee) return res.status(404).json({ success: false, message: 'Not found' });
    const { password_hash, ...safe } = employee;
    return res.json({ success: true, employee: safe });
  } catch (error) {
    console.error('getProfile error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getTimeline = async (req, res) => {
  try {
    const events = await prisma.employmentEvent.findMany({
      where: { employee_id: req.employee.id },
      orderBy: { event_date: 'desc' },
    });
    return res.json({ success: true, events });
  } catch (error) {
    console.error('getTimeline error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getAttendance = async (req, res) => {
  try {
    const month = parseInt(req.query.month) || now().getMonth() + 1;
    const year = parseInt(req.query.year) || now().getFullYear();

    const records = await prisma.employeeAttendance.findMany({
      where: {
        employee_id: req.employee.id,
        date: {
          gte: new Date(Date.UTC(year, month - 1, 1)),
          lte: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
        },
      },
      orderBy: { date: 'asc' },
    });

    const summary = {
      present: records.filter((r) => r.status === 'present').length,
      absent: records.filter((r) => r.status === 'absent').length,
      late: records.filter((r) => r.status === 'late').length,
      off: records.filter((r) => r.status === 'off').length,
      holiday: records.filter((r) => r.status === 'holiday').length,
      overtime_hours: records.reduce((s, r) => s + (r.overtime_hrs || 0), 0),
      missed_punches: records.filter((r) => r.missed_punch).length,
    };

    return res.json({ success: true, month, year, records, summary });
  } catch (error) {
    console.error('getAttendance error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getPayroll = async (req, res) => {
  try {
    const slips = await prisma.payrollSlip.findMany({
      where: { employee_id: req.employee.id },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    return res.json({ success: true, slips });
  } catch (error) {
    console.error('getPayroll error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getLoans = async (req, res) => {
  try {
    const loans = await prisma.employeeLoan.findMany({
      where: { employee_id: req.employee.id },
      orderBy: { created_at: 'desc' },
    });
    return res.json({ success: true, loans });
  } catch (error) {
    console.error('getLoans error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getLeaves = async (req, res) => {
  try {
    const employee = await prisma.employee.findUnique({ where: { id: req.employee.id } });
    const requests = await prisma.leaveRequest.findMany({
      where: { employee_id: req.employee.id },
      orderBy: { created_at: 'desc' },
    });
    const balances = {
      annual: { total: employee.annual_leave_total, used: employee.annual_leave_used, remaining: employee.annual_leave_total - employee.annual_leave_used },
      sick: { total: employee.sick_leave_total, used: employee.sick_leave_used, remaining: employee.sick_leave_total - employee.sick_leave_used },
      emergency: { total: employee.emergency_leave_total, used: employee.emergency_leave_used, remaining: employee.emergency_leave_total - employee.emergency_leave_used },
      unpaid: { used: employee.unpaid_leave_used },
    };
    return res.json({ success: true, balances, requests });
  } catch (error) {
    console.error('getLeaves error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const applyLeave = async (req, res) => {
  try {
    const { leave_type, from_date, to_date, reason } = req.body;
    if (!leave_type || !from_date || !to_date || !reason) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }
    const from = new Date(from_date);
    const to = new Date(to_date);
    const days = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;

    const request = await prisma.leaveRequest.create({
      data: {
        employee_id: req.employee.id,
        leave_type,
        from_date: from,
        to_date: to,
        days,
        reason,
        status: 'pending',
      },
    });

    await prisma.employeeNotification.create({
      data: {
        employee_id: req.employee.id,
        title: 'Leave Application Submitted',
        message: `Your ${leave_type} leave request for ${days} day(s) is pending approval.`,
        type: 'approval',
      },
    });

    return res.status(201).json({ success: true, request });
  } catch (error) {
    console.error('applyLeave error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getNotifications = async (req, res) => {
  try {
    const type = req.query.type;
    const where = { employee_id: req.employee.id };
    if (type) where.type = type;

    const notifications = await prisma.employeeNotification.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
    return res.json({ success: true, notifications });
  } catch (error) {
    console.error('getNotifications error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const markNotificationsRead = async (req, res) => {
  try {
    const { ids } = req.body;
    if (ids?.length) {
      await prisma.employeeNotification.updateMany({
        where: { id: { in: ids }, employee_id: req.employee.id },
        data: { is_read: true },
      });
    } else {
      await prisma.employeeNotification.updateMany({
        where: { employee_id: req.employee.id },
        data: { is_read: true },
      });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('markNotificationsRead error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getDocuments = async (req, res) => {
  try {
    const documents = await prisma.employeeDocument.findMany({
      where: { employee_id: req.employee.id },
      orderBy: { created_at: 'desc' },
    });
    return res.json({ success: true, documents });
  } catch (error) {
    console.error('getDocuments error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getPerformance = async (req, res) => {
  try {
    const month = parseInt(req.query.month) || now().getMonth() + 1;
    const year = parseInt(req.query.year) || now().getFullYear();

    const [current, history] = await Promise.all([
      prisma.employeePerformance.findUnique({
        where: { employee_id_month_year: { employee_id: req.employee.id, month, year } },
      }),
      prisma.employeePerformance.findMany({
        where: { employee_id: req.employee.id },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        take: 12,
      }),
    ]);

    return res.json({ success: true, current, history });
  } catch (error) {
    console.error('getPerformance error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const approveLeave = async (req, res) => {
  try {
    const requestId = parseInt(req.params.requestId);
    const { status, rejection_reason } = req.body;
    const request = await prisma.leaveRequest.findFirst({
      where: { id: requestId },
      include: { employee: true },
    });
    if (!request) return res.status(404).json({ success: false, message: 'Request not found.' });

    const updated = await prisma.$transaction(async (tx) => {
      const req_ = await tx.leaveRequest.update({
        where: { id: requestId },
        data: { status, rejection_reason: rejection_reason || null, updated_at: now() },
      });
      if (status === 'approved') {
        const fieldMap = {
          annual: 'annual_leave_used',
          sick: 'sick_leave_used',
          emergency: 'emergency_leave_used',
          unpaid: 'unpaid_leave_used',
        };
        const updateField = fieldMap[request.leave_type] || 'annual_leave_used';
        await tx.employee.update({
          where: { id: request.employee_id },
          data: { [updateField]: { increment: request.days } },
        });
      }
      await tx.employeeNotification.create({
        data: {
          employee_id: request.employee_id,
          title: `Leave ${status}`,
          message: status === 'approved'
            ? `Your leave request has been approved.`
            : `Your leave request was rejected. ${rejection_reason || ''}`,
          type: status === 'approved' ? 'approval' : 'warning',
        },
      });
      return req_;
    });

    return res.json({ success: true, request: updated });
  } catch (error) {
    console.error('approveLeave error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getPendingLeaves = async (req, res) => {
  try {
    const requests = await prisma.leaveRequest.findMany({
      where: { status: 'pending' },
      include: { employee: { select: { id: true, full_name: true, employee_id: true, department: true } } },
      orderBy: { created_at: 'desc' },
    });
    return res.json({ success: true, requests });
  } catch (error) {
    console.error('getPendingLeaves error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  getDashboard,
  getProfile,
  getTimeline,
  getAttendance,
  getPayroll,
  getLoans,
  getLeaves,
  applyLeave,
  getNotifications,
  markNotificationsRead,
  getDocuments,
  getPerformance,
  approveLeave,
  getPendingLeaves,
};
