const prisma = require('../../lib/prisma');
const { getDateRangeFilter } = require('../utils/dateRangeUtils');

const getReportSummary = async (req, res) => {
  try {
    const {
      dateRange = 'Month',
      startDate,
      endDate,
      status,
      channel,
      city,
    } = req.query;

    const createdFilter = getDateRangeFilter(dateRange, startDate, endDate);

    const baseWhere = {};
    if (createdFilter) {
      baseWhere.created_at = createdFilter;
    }

    if (status) {
      const list = String(status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 1) {
        baseWhere.status = list[0];
      } else if (list.length > 1) {
        baseWhere.status = { in: list };
      }
    }

    if (channel) {
      const list = String(channel)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 1) {
        baseWhere.channel = list[0];
      } else if (list.length > 1) {
        baseWhere.channel = { in: list };
      }
    }

    if (city) {
      baseWhere.city = String(city).trim();
    }

    const [
      orderStatusAgg,
      ordersByChannel,
      ordersByCity,
      ordersByDayRaw,
      salesByDayRaw,
      totalOrders,
      customerCount,
      collectionAgg,
    ] = await Promise.all([
      prisma.order.groupBy({
        by: ['status'],
        _count: { _all: true },
        where: baseWhere,
      }),
      prisma.order.groupBy({
        by: ['channel'],
        _count: { _all: true },
        where: baseWhere,
      }),
      prisma.order.groupBy({
        by: ['city'],
        _count: { _all: true },
        where: baseWhere,
      }),
      prisma.order.groupBy({
        by: ['created_at'],
        _count: { _all: true },
        where: baseWhere,
      }),
      prisma.order.groupBy({
        by: ['created_at'],
        _sum: { total_amount: true, advance_amount: true },
        where: { ...baseWhere, is_delivered: true },
      }),
      prisma.order.count({ where: baseWhere }),
      prisma.order.groupBy({
        by: ['whatsapp_number'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.installmentLedger.findMany({
        where: {
          order: baseWhere,
        },
        select: {
          ledger_rows: true
        }
      }),
    ]);

    const ordersByDay = ordersByDayRaw;
    const salesByDay = salesByDayRaw || [];

    // Manually aggregate collections from ledger rows in JS (since it's a JSON field)
    let totalInstallments = 0;
    let totalAdvance = 0;

    for (const ledger of collectionAgg) {
      const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
      for (const row of rows) {
        if (row.status === 'paid') {
          const amount = parseFloat(row.amount || row.dueAmount || 0);
          if (row.month === 0) {
            totalAdvance += amount;
          } else {
            totalInstallments += amount;
          }
        }
      }
    }

    const collectionResults = [
      { paymentType: 'advance', _sum: { amount: totalAdvance } },
      { paymentType: 'installment', _sum: { amount: totalInstallments } }
    ];

    const dailyMap = {};
    for (const row of ordersByDay) {
      const dayKey = row.created_at.toISOString().slice(0, 10);
      if (!dailyMap[dayKey]) {
        dailyMap[dayKey] = {
          date: dayKey,
          count: 0,
          totalAmount: 0,
          advanceAmount: 0,
        };
      }
      dailyMap[dayKey].count += row._count._all;
    }

    for (const row of salesByDay) {
      const dayKey = row.created_at.toISOString().slice(0, 10);
      if (!dailyMap[dayKey]) {
        dailyMap[dayKey] = {
          date: dayKey,
          count: 0,
          totalAmount: 0,
          advanceAmount: 0,
        };
      }
      dailyMap[dayKey].totalAmount += row._sum.total_amount || 0;
      dailyMap[dayKey].advanceAmount += row._sum.advance_amount || 0;
    }

    const dailyTrend = Object.values(dailyMap).sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );

    const ordersByStatus = orderStatusAgg.reduce((acc, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});

    const byChannel = ordersByChannel.map((row) => ({
      channel: row.channel || 'Unknown',
      count: row._count._all,
    }));

    const byCity = ordersByCity
      .filter((row) => row.city)
      .map((row) => ({
        city: row.city,
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const totalCustomers = customerCount.length;

    totalReceived = totalAdvance + totalInstallments;

    // Simple pending estimate based on orders in range
    const pendingAgg = await prisma.order.aggregate({
      where: baseWhere,
      _sum: {
        total_amount: true,
      },
    });
    const grossAmount = pendingAgg._sum.total_amount || 0;
    totalPending = Math.max(0, grossAmount - totalReceived);

    return res.json({
      success: true,
      data: {
        meta: {
          dateRange,
          startDate: createdFilter?.gte || null,
          endDate: createdFilter?.lt || null,
        },
        overview: {
          totalOrders,
          totalCustomers,
          ordersByStatus,
          totalReceived,
          totalPending,
        },
        breakdown: {
          byChannel,
          byCity,
          dailyTrend,
        },
      },
    });
  } catch (error) {
    console.error('getReportSummary error:', error);
    return res
      .status(500)
      .json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

module.exports = {
  getReportSummary,
};

