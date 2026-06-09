const prisma = require('../../lib/prisma');
const { updateDeliveryRanking, getWorkingDaysLeftInMonth } = require('../services/rankingService');

const getDeliveryOfficerAnalytics = async (req, res) => {
  try {
    const { filter = 'today', startDate, endDate } = req.query;
    const userId = req.user.id;

    // Trigger async ranking update
    updateDeliveryRanking(userId, 'today').catch(err => console.error('Auto-ranking update error:', err));
    updateDeliveryRanking(userId, 'month').catch(err => console.error('Auto-ranking update error:', err));

    const now = new Date();
    let start, end;

    if (filter === 'today') {
      start = new Date(now); start.setHours(0, 0, 0, 0);
      end = new Date(now); end.setHours(23, 59, 59, 999);
    } else if (filter === 'month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (filter === 'custom' && startDate && endDate) {
      start = new Date(startDate); start.setHours(0, 0, 0, 0);
      end = new Date(endDate); end.setHours(23, 59, 59, 999);
    } else {
      start = new Date(now); start.setHours(0, 0, 0, 0);
      end = new Date(now); end.setHours(23, 59, 59, 999);
    }

    const dateFilter = { gte: start, lte: end };

    // 1. Deliveries assigned
    const deliveries = await prisma.delivery.findMany({
      where: {
        delivery_agent_id: userId,
        updated_at: dateFilter
      },
      include: { order: true }
    });

    let assignedOrders = 0;
    let deliveredOrders = 0;
    let newDeliveries = 0; // 'picked' status from order perspective, or 'pending' delivery
    let homeLocationRequired = 0;
    let cancelledCount = 0;
    let rejectedCount = 0;
    let expiredCount = 0;
    let postponedCount = 0;
    let deliveredSalesAmount = 0;

    const uniqueCustomerIds = new Set();

    deliveries.forEach(d => {
      assignedOrders++;
      
      // We look at the order's status and the delivery's status
      if (d.status === 'delivered') {
          deliveredOrders++;
          deliveredSalesAmount += (d.order?.total_amount || 0);
      }
      
      if (d.status === 'pending') newDeliveries++;
      if (d.status === 'cancelled') cancelledCount++;
      if (d.status === 'rejected') rejectedCount++;
      if (d.status === 'expired') expiredCount++;
      if (d.status === 'postponed') postponedCount++;
    });

    // To get homeLocationRequired, we query Verification associated with these deliveries
    const orderIds = deliveries.map(d => d.order_id);
    if (orderIds.length > 0) {
        const verifications = await prisma.verification.findMany({
            where: { order_id: { in: orderIds }, home_location_required: true }
        });
        homeLocationRequired = verifications.length;
    }

    const customersDone = deliveredOrders; // Do not use uniqueCustomerIds

    // 2. Profile History (Bike Range, Working Hours)
    const user = await prisma.user.findUnique({ where: { id: userId } });
    let totalWorkingHours = 0;
    let totalKM = 0;


    if (user && user.officer_profile_history) {
      const history = user.officer_profile_history;
      history.forEach(h => {
        const hDate = new Date(h.date || h.day || h.timestamp);
        if (hDate >= start && hDate <= end) {
          if (h.working_hours) totalWorkingHours += Number(h.working_hours);
          if (h.km) totalKM += Number(h.km);
          if (h.bike_km) totalKM += Number(h.bike_km);
        }
      });
    }

    // 3. Stock Value & Qty
    const stockTransfers = await prisma.stockTransfer.findMany({
        where: {
            to_type: 'User',
            to_id: userId,
            status: 'completed',
        },
        include: { inventory: true }
    });

    // Cash In Hand
    const cashEntries = await prisma.cashInHand.findMany({
      where: {
        officer_id: userId,
        status: { in: ['pending', 'partial'] }
      }
    });

    const totalCashInHand = cashEntries.reduce((sum, c) => {
        return sum + (c.amount - (c.submitted_amount || 0));
    }, 0);

    let stockValue = 0;
    let stockQty = 0;
    
    stockTransfers.forEach(st => {
        stockQty += st.quantity_transferred;
        stockValue += (st.inventory?.installment_price || st.inventory?.purchase_price || 0) * st.quantity_transferred;
    });

    const allTimeDelivered = await prisma.delivery.findMany({
        where: { delivery_agent_id: userId, status: 'delivered' },
        include: { order: true }
    });
    
    allTimeDelivered.forEach(d => {
        stockQty -= 1;
        stockValue -= (d.order?.total_amount || 0);
    });

    if (stockQty < 0) stockQty = 0;
    if (stockValue < 0) stockValue = 0;

    // 4. Rankings
    const rankingPeriod = filter === 'custom' ? 'month' : filter;
    const allRankings = await prisma.deliveryRanking.findMany({
        where: {
            period: rankingPeriod,
            month: rankingPeriod === 'month' ? start.getMonth() + 1 : 0,
            year: rankingPeriod === 'month' ? start.getFullYear() : 0,
        },
        orderBy: [
            { score: 'desc' },
            { delivered_customers: 'desc' }
        ],
        include: { user: { include: { outlet: true } } }
    });

    let rankPosition = 1;
    for (let i = 0; i < allRankings.length; i++) {
        if (i > 0 && allRankings[i].score < allRankings[i-1].score) {
            rankPosition = i + 1;
        }
        allRankings[i].computedRank = rankPosition;
        allRankings[i].league = rankPosition <= 3 ? 'Diamond' : (rankPosition <= 10 ? 'Gold' : 'Silver');
    }

    const officerRanking = allRankings.map(r => ({
        rank: r.computedRank,
        name: r.user?.username || r.user?.full_name || 'Officer',
        outletName: r.user?.outlet?.name || 'Main',
        score: r.score,
        league: r.league,
        isMe: r.officer_id === userId
    }));

    // 5. Target Tracking
    const monthlyTarget = process.env.DELIVERY_TARGET_AMOUNT || 500000;
    const customerTarget = process.env.DELIVERY_TARGET_CUSTOMERS || 50;
    const remainingAmount = Math.max(0, monthlyTarget - deliveredSalesAmount);
    const remainingCustomers = Math.max(0, customerTarget - customersDone);
    
    // 6. Channel breakdown
    const channelGroups = await prisma.delivery.findMany({
      where: { delivery_agent_id: userId, updated_at: dateFilter },
      include: { order: true }
    });

    const channelMap = {};
    channelGroups.forEach(d => {
      const ch = (d.order?.channel || 'unknown').toLowerCase();
      if (!channelMap[ch]) channelMap[ch] = { total: 0, delivered: 0, cancelled: 0 };
      channelMap[ch].total += 1;
      if (d.status === 'delivered') channelMap[ch].delivered += 1;
      if (d.status === 'cancelled') channelMap[ch].cancelled += 1;
    });

    const buildChannelStats = (names) => {
      const combined = { total: 0, delivered: 0, cancelled: 0 };
      names.forEach(n => {
        const data = channelMap[n.toLowerCase()];
        if (data) {
          combined.total += data.total;
          combined.delivered += data.delivered;
          combined.cancelled += data.cancelled;
        }
      });
      combined.successRate = combined.total > 0 ? Math.round((combined.delivered / combined.total) * 100) : 0;
      combined.cancelRate = combined.total > 0 ? Math.round((combined.cancelled / combined.total) * 100) : 0;
      return combined;
    };

    const channelStats = {
      referral: buildChannelStats(['referral', 'outlet referral']),
      call: buildChannelStats(['call']),
      whatsapp: buildChannelStats(['whatsapp', 'whats_app', 'whats app']),
      website: buildChannelStats(['website']),
    };

    return res.status(200).json({
      success: true,
      data: {
        assignedOrders,
        deliveredOrders,
        newDeliveries,
        homeLocationRequired,
        cancelledCount,
        rejectedCount,
        expiredCount,
        postponedCount,
        bikeRange: totalKM,
        workingHours: Math.round(totalWorkingHours * 100) / 100,
        customersDone,
        stockValue,
        stockQty,
        cashInHand: totalCashInHand,
        deliveredSalesAmount,
        officerRanking,
        targetTracking: {
            achievedAmount: deliveredSalesAmount,
            targetAmount: Number(monthlyTarget),
            remainingAmount,
            achievedCustomers: customersDone,
            targetCustomers: Number(customerTarget),
            remainingCustomers
        },
        sourceSuccessRate: channelStats
      }
    });

  } catch (error) {
    console.error('getDeliveryOfficerAnalytics error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

module.exports = {
  getDeliveryOfficerAnalytics
};
