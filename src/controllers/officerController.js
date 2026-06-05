const prisma = require('../../lib/prisma');
const { getVerificationDashboardStats } = require('./verificationController');
const { getDeliveryDashboardStats } = require('./deliveryController');
const { getRecoveryDashboardStats } = require('./recoveryController');

const now = () => new Date();

const getExpectedWorkMinutes = (startStr, endStr) => {
  if (!startStr || !endStr) return 480; // 8h default
  const parseTime = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  let diff = parseTime(endStr) - parseTime(startStr);
  if (diff < 0) diff += 24 * 60;
  return diff;
};

const getAllVerificationOfficers = async (req, res) => {
  if (![4, 5, 6, 7, 8].includes(req.user.role_id)) {
    return res.status(403).json({ success: false, error: { code: 403, message: 'Access denied. Admin only.' } });
  }

  try {
    const officers = await prisma.user.findMany({
      where: { role: { name: 'Verification Officer' } },
      select: {
        id: true,
        full_name: true,
        username: true,
        phone: true,
        status: true,
        is_online: true,
        last_known_latitude: true,
        last_known_longitude: true,
        last_online_at: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        officer_profile_history: true,
        current_active_verification_id: true,
        current_active_verification: {
          select: {
            id: true,
            status: true,
            order: { select: { order_ref: true, customer_name: true } },
          },
        },
      },
      orderBy: { full_name: 'asc' },
    });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyStatsRaw = await prisma.officerSession.groupBy({
      by: ['officer_id'],
      where: { start_time: { gte: startOfMonth } },
      _sum: { duration_minutes: true },
    });

    const monthlyStatsMap = new Map(
      monthlyStatsRaw.map((s) => [s.officer_id, ((s._sum.duration_minutes || 0) / 60).toFixed(2)])
    );


    // Import the shared in-memory map
    const officerVerificationActiveMap = require('../utils/officerVerificationActiveMap');

    const formatted = officers.map((o) => {
      return {
        id: o.id,
        full_name: o.full_name,
        username: o.username,
        phone: o.phone,
        account_status: o.status,
        is_online: o.is_online,
        last_online_at: o.last_online_at,
        current_location:
          o.is_online && o.last_known_latitude
            ? { latitude: o.last_known_latitude, longitude: o.last_known_longitude }
            : null,
        last_known_location:
          !o.is_online && o.last_known_latitude
            ? {
              latitude: o.last_known_latitude,
              longitude: o.last_known_longitude,
              timestamp: o.last_online_at,
            }
            : null,
        bike_km_range: o.bike_km_range,
        working_hours:
          o.working_hours_start && o.working_hours_end
            ? `${o.working_hours_start} - ${o.working_hours_end}`
            : null,
        current_verification: o.current_active_verification,
        monthly_online_hours: monthlyStatsMap.get(o.id) || '0.00',
        profile_history: o.officer_profile_history || [],
      };
    });

    return res.json({ success: true, data: { officers: formatted } });
  } catch (error) {
    console.error('getAllVerificationOfficers error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getOfficerProfileDetail = async (req, res) => {
  const { officerId } = req.params;

  if (![4, 5, 6, 7, 8].includes(req.user.role_id)) {
    return res.status(403).json({ success: false, error: { code: 403, message: 'Access denied. Admin only.' } });
  }

  try {
    const officer = await prisma.user.findUnique({
      where: { id: parseInt(officerId) },
      select: {
        id: true,
        full_name: true,
        username: true,
        phone: true,
        status: true,
        is_online: true,
        last_known_latitude: true,
        last_known_longitude: true,
        last_online_at: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        officer_profile_history: true,
      },
    });

    if (!officer) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Officer not found' } });
    }

    return res.json({
      success: true,
      data: {
        id: officer.id,
        full_name: officer.full_name,
        username: officer.username,
        phone: officer.phone,
        account_status: officer.status,
        is_online: officer.is_online,
        last_online_at: officer.last_online_at,
        bike_km_range: officer.bike_km_range,
        working_hours_start: officer.working_hours_start,
        working_hours_end: officer.working_hours_end,
        profile_history: officer.officer_profile_history || [],
      },
    });
  } catch (error) {
    console.error('getOfficerProfileDetail error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const updateOfficerProfile = async (req, res) => {
  const { bike_km_range, working_hours_start, working_hours_end } = req.body;

  try {
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        officer_profile_history: true,
      },
    });

    if (!currentUser) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'User not found' } });
    }

    // Parse existing history from JSON string
    let existingHistory = [];
    if (currentUser.officer_profile_history) {
      existingHistory = currentUser.officer_profile_history;
    }

    const updatedBikeKmRange =
      bike_km_range !== undefined && bike_km_range !== null && bike_km_range !== ''
        ? parseInt(bike_km_range, 10)
        : currentUser.bike_km_range;
    const updatedStart = working_hours_start !== undefined ? working_hours_start : currentUser.working_hours_start;
    const updatedEnd = working_hours_end !== undefined ? working_hours_end : currentUser.working_hours_end;

    const hasChange =
      updatedBikeKmRange !== currentUser.bike_km_range ||
      updatedStart !== currentUser.working_hours_start ||
      updatedEnd !== currentUser.working_hours_end;

    const historyEntry = hasChange
      ? {
          updatedAt: new Date(),
          previous: {
            bike_km_range: currentUser.bike_km_range,
            working_hours_start: currentUser.working_hours_start,
            working_hours_end: currentUser.working_hours_end,
          },
          updated: {
            bike_km_range: updatedBikeKmRange,
            working_hours_start: updatedStart,
            working_hours_end: updatedEnd,
          },
        }
      : null;

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(bike_km_range !== undefined && bike_km_range !== null && bike_km_range !== '' && {
          bike_km_range: updatedBikeKmRange,
        }),
        ...(working_hours_start !== undefined && { working_hours_start: updatedStart }),
        ...(working_hours_end !== undefined && { working_hours_end: updatedEnd }),
        ...(historyEntry && {
          officer_profile_history: [...existingHistory, historyEntry],
        }),
        updated_at: now(),   // ✅ explicit updated_at
      },
      select: {
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        officer_profile_history: true,
      },
    });

    // Parse the updated history for response
    let parsedHistory = [];
    if (updated.officer_profile_history) {
      parsedHistory = updated.officer_profile_history;
    }

    // Emit socket event if profile was updated
    if (hasChange) {
      const io = req.app.get('io');
      if (io) {
        io.to('admins').emit('officer_profile_updated', {
          officerId: req.user.id,
          profile_history: parsedHistory,
        });
      }
    }

    return res.json({ success: true, message: 'Profile updated', data: {
      ...updated,
      officer_profile_history: parsedHistory,
    } });
  } catch (error) {
    console.error('updateOfficerProfile error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getMyOfficerStatus = async (req, res) => {
  try {
    const status = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        is_online: true,
        last_known_latitude: true,
        last_known_longitude: true,
        last_online_at: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        officer_profile_history: true,
      },
    });

    if (!status) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Officer not found' } });
    }

    return res.json({ success: true, data: status });
  } catch (error) {
    console.error('getMyOfficerStatus error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getOfficerDailyStats = async (req, res) => {
  const { id } = req.params;
  const { month, year } = req.query;

  if (![4, 5, 6, 7, 8].includes(req.user.role_id)) {
    return res.status(403).json({ success: false, error: { message: 'Access denied' } });
  }

  try {
    const officer = await prisma.user.findUnique({
      where: { id: parseInt(id) },
      select: { working_hours_start: true, working_hours_end: true },
    });

    if (!officer) return res.status(404).json({ success: false, error: 'Officer not found' });

    let startDate, endDate;
    if (year && month) {
      startDate = new Date(Number(year), Number(month) - 1, 1);
      endDate = new Date(Number(year), Number(month), 0);
    } else {
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    }

    const sessions = await prisma.officerSession.findMany({
      where: {
        officer_id: parseInt(id),
        start_time: { gte: startDate, lte: endDate },
      },
      select: { start_time: true, end_time: true, duration_minutes: true },
      orderBy: { start_time: 'asc' },
    });

    // Group sessions by date
    const dailyMap = new Map();
    sessions.forEach((s) => {
      const dateKey = s.start_time.toISOString().split('T')[0];
      if (!dailyMap.has(dateKey)) dailyMap.set(dateKey, []);
      dailyMap.get(dateKey).push({
        start_time: s.start_time,
        end_time: s.end_time,
        duration_minutes: s.duration_minutes,
      });
    });

    const dailyStats = [];
    let current = new Date(startDate);
    while (current <= endDate) {
      const dateKey = current.toISOString().split('T')[0];
      dailyStats.push({
        date: dateKey,
        sessions: dailyMap.get(dateKey) || [],
      });
      current.setDate(current.getDate() + 1);
    }

    return res.json({
      success: true,
      data: {
        officer_id: Number(id),
        month: startDate.toISOString().slice(0, 7),
        daily_stats: dailyStats,
      },
    });
  } catch (error) {
    console.error('getOfficerDailyStats error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const getAllDeliveryOfficers = async (req, res) => {
  if (![4, 5, 6, 7, 8].includes(req.user.role_id)) {
    return res.status(403).json({ success: false, error: { code: 403, message: 'Access denied. Admin only.' } });
  }

  try {
    const officers = await prisma.user.findMany({
      where: { role: { name: 'Delivery Officer' } },
      select: {
        id: true,
        full_name: true,
        username: true,
        phone: true,
        status: true,
        is_online: true,
        last_known_latitude: true,
        last_known_longitude: true,
        last_online_at: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        officer_profile_history: true,
        deliveries: {
          where: { status: 'in_progress' },
          select: {
            id: true,
            status: true,
            order: { select: { order_ref: true, customer_name: true } },
          },
          take: 1,
        },
      },
      orderBy: { full_name: 'asc' },
    });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyStatsRaw = await prisma.officerSession.groupBy({
      by: ['officer_id'],
      where: { start_time: { gte: startOfMonth } },
      _sum: { duration_minutes: true },
    });

    const monthlyStatsMap = new Map(
      monthlyStatsRaw.map((s) => [s.officer_id, ((s._sum.duration_minutes || 0) / 60).toFixed(2)])
    );

    const formatted = officers.map((o) => ({
      id: o.id,
      full_name: o.full_name,
      username: o.username,
      phone: o.phone,
      account_status: o.status,
      is_online: o.is_online,
      last_online_at: o.last_online_at,
      current_location:
        o.is_online && o.last_known_latitude
          ? { latitude: o.last_known_latitude, longitude: o.last_known_longitude }
          : null,
      last_known_location:
        !o.is_online && o.last_known_latitude
          ? {
            latitude: o.last_known_latitude,
            longitude: o.last_known_longitude,
            timestamp: o.last_online_at,
          }
          : null,
      bike_km_range: o.bike_km_range,
      working_hours:
        o.working_hours_start && o.working_hours_end
          ? `${o.working_hours_start} - ${o.working_hours_end}`
          : null,
      current_delivery: o.deliveries[0] || null,
      monthly_online_hours: monthlyStatsMap.get(o.id) || '0.00',
      profile_history: o.officer_profile_history || [],
    }));

    return res.json({ success: true, data: { officers: formatted } });
  } catch (error) {
    console.error('getAllDeliveryOfficers error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getAllRecoveryOfficers = async (req, res) => {
  if (![4, 5, 6, 7, 8].includes(req.user.role_id)) {
    return res.status(403).json({ success: false, error: { code: 403, message: 'Access denied. Admin only.' } });
  }

  try {
    const officers = await prisma.user.findMany({
      where: { role: { name: 'Recovery Officer' } },
      select: {
        id: true,
        full_name: true,
        username: true,
        phone: true,
        status: true,
        is_online: true,
        last_known_latitude: true,
        last_known_longitude: true,
        last_online_at: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        officer_profile_history: true,
        recovery_orders: {
          where: { status: 'in_progress' },
          select: {
            id: true,
            status: true,
            order_ref: true,
            customer_name: true,
          },
          take: 1,
        },
      },
      orderBy: { full_name: 'asc' },
    });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyStatsRaw = await prisma.officerSession.groupBy({
      by: ['officer_id'],
      where: { start_time: { gte: startOfMonth } },
      _sum: { duration_minutes: true },
    });

    const monthlyStatsMap = new Map(
      monthlyStatsRaw.map((s) => [s.officer_id, ((s._sum.duration_minutes || 0) / 60).toFixed(2)])
    );

    const formatted = officers.map((o) => ({
      id: o.id,
      full_name: o.full_name,
      username: o.username,
      phone: o.phone,
      account_status: o.status,
      is_online: o.is_online,
      last_online_at: o.last_online_at,
      current_location:
        o.is_online && o.last_known_latitude
          ? { latitude: o.last_known_latitude, longitude: o.last_known_longitude }
          : null,
      last_known_location:
        !o.is_online && o.last_known_latitude
          ? {
            latitude: o.last_known_latitude,
            longitude: o.last_known_longitude,
            timestamp: o.last_online_at,
          }
          : null,
      bike_km_range: o.bike_km_range,
      working_hours:
        o.working_hours_start && o.working_hours_end
          ? `${o.working_hours_start} - ${o.working_hours_end}`
          : null,
      current_recovery: o.recovery_orders[0] || null,
      monthly_online_hours: monthlyStatsMap.get(o.id) || '0.00',
      profile_history: o.officer_profile_history || [],
    }));

    return res.json({ success: true, data: { officers: formatted } });
  } catch (error) {
    console.error('getAllRecoveryOfficers error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getDeliveryOfficerProfileDetail = async (req, res) => {
  const { officerId } = req.params;

  if (![4, 5, 6, 7, 8].includes(req.user.role_id)) {
    return res.status(403).json({ success: false, error: { code: 403, message: 'Access denied. Admin only.' } });
  }

  try {
    const officer = await prisma.user.findUnique({
      where: { id: parseInt(officerId) },
      select: {
        id: true,
        full_name: true,
        username: true,
        phone: true,
        status: true,
        is_online: true,
        last_known_latitude: true,
        last_known_longitude: true,
        last_online_at: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        officer_profile_history: true,
      },
    });

    if (!officer) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Officer not found' } });
    }

    return res.json({
      success: true,
      data: {
        id: officer.id,
        full_name: officer.full_name,
        username: officer.username,
        phone: officer.phone,
        account_status: officer.status,
        is_online: officer.is_online,
        last_online_at: officer.last_online_at,
        bike_km_range: officer.bike_km_range,
        working_hours_start: officer.working_hours_start,
        working_hours_end: officer.working_hours_end,
        profile_history: Array.isArray(officer.officer_profile_history) ? officer.officer_profile_history : [],
      },
    });
  } catch (error) {
    console.error('getDeliveryOfficerProfileDetail error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getRecoveryOfficerProfileDetail = async (req, res) => {
  const { officerId } = req.params;

  if (![4, 5, 6, 7, 8].includes(req.user.role_id)) {
    return res.status(403).json({ success: false, error: { code: 403, message: 'Access denied. Admin only.' } });
  }

  try {
    const officer = await prisma.user.findUnique({
      where: { id: parseInt(officerId) },
      select: {
        id: true,
        full_name: true,
        username: true,
        phone: true,
        status: true,
        is_online: true,
        last_known_latitude: true,
        last_known_longitude: true,
        last_online_at: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        officer_profile_history: true,
      },
    });

    if (!officer) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Officer not found' } });
    }

    return res.json({
      success: true,
      data: {
        id: officer.id,
        full_name: officer.full_name,
        username: officer.username,
        phone: officer.phone,
        account_status: officer.status,
        is_online: officer.is_online,
        last_online_at: officer.last_online_at,
        bike_km_range: officer.bike_km_range,
        working_hours_start: officer.working_hours_start,
        working_hours_end: officer.working_hours_end,
        profile_history: Array.isArray(officer.officer_profile_history) ? officer.officer_profile_history : [],
      },
    });
  } catch (error) {
    console.error('getRecoveryOfficerProfileDetail error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getOfficerDashboardStats = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { role: true }
        });

        if (!user || !user.role) {
            return res.status(403).json({ success: false, message: 'Role not found' });
        }

        const roleName = user.role.name;

        if (roleName.includes('Verification Officer')) {
            return getVerificationDashboardStats(req, res);
        } else if (roleName.includes('Delivery Agent')) {
            return getDeliveryDashboardStats(req, res);
        } else if (roleName.includes('Recovery Officer')) {
            return getRecoveryDashboardStats(req, res);
        } else {
            return res.status(403).json({ success: false, message: 'Dashboard not available for this role' });
        }
    } catch (error) {
        console.error('Unified Dashboard Error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
  getAllVerificationOfficers,
  getOfficerProfileDetail,
  getAllDeliveryOfficers,
  getDeliveryOfficerProfileDetail,
  getAllRecoveryOfficers,
  getRecoveryOfficerProfileDetail,
  updateOfficerProfile,
  getMyOfficerStatus,
  getOfficerDailyStats,
  getOfficerDashboardStats,
};