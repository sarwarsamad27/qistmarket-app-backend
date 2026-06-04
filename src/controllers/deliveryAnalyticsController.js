const prisma = require('../../lib/prisma');

function getDateRange(range, start, end) {
  const now = new Date();
  let gte, lt;
  switch (range) {
    case 'Day':
      gte = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      lt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      break;
    case 'Week':
      const day = now.getDay();
      gte = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
      lt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (7 - day));
      break;
    case 'Month':
      gte = new Date(now.getFullYear(), now.getMonth(), 1);
      lt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      break;
    case 'Custom':
      gte = new Date(start);
      lt = new Date(end);
      break;
    default:
      gte = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      lt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }
  return { gte, lt };
}

const getDeliveryOfficerAnalytics = async (req, res) => {
  const { range = 'Day', start, end } = req.query;
  const deliveryOfficerId = req.user.id;
  const { gte, lt } = getDateRange(range, start, end);

  try {
    // All deliveries for this officer in range
    const deliveries = await prisma.delivery.findMany({
      where: {
        delivery_agent_id: deliveryOfficerId,
        end_time: { gte, lt }
      },
      include: {
        order: true
      }
    });

    // Sales (sum of delivered orders' total_amount)
    const sales = deliveries.reduce((sum, d) => sum + (d.order?.total_amount || 0), 0);

    // Inventory reports (delivered products)
    const deliveredProducts = deliveries.map(d => ({
      product_name: d.order?.product_name,
      total_amount: d.order?.total_amount,
      advance_amount: d.order?.advance_amount,
      monthly_amount: d.order?.monthly_amount,
      months: d.order?.months
    }));

    // Cash in hand (sum of cashInHand for this officer in range)
    const cashEntries = await prisma.cashInHand.findMany({
      where: {
        officer_id: deliveryOfficerId,
        created_at: { gte, lt }
      }
    });
    const totalCashInHand = cashEntries.reduce((sum, c) => sum + (c.amount || 0), 0);

    // Officer profile history for working hours and KM
    const user = await prisma.user.findUnique({ where: { id: deliveryOfficerId } });
    let totalWorkingHours = 0;
    let totalKM = 0;
    if (user && user.officer_profile_history) {
      const history = user.officer_profile_history;
      // Filter by date range if possible
      history.forEach(h => {
        const date = new Date(h.date || h.day || h.timestamp);
        if (date >= gte && date < lt) {
          if (h.working_hours) totalWorkingHours += Number(h.working_hours);
          if (h.km) totalKM += Number(h.km);
          if (h.bike_km) totalKM += Number(h.bike_km);
        }
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        sales,
        totalKM,
        totalWorkingHours: Math.round(totalWorkingHours * 100) / 100,
        deliveredProducts,
        totalCashInHand
      }
    });
  } catch (error) {
    console.error('getDeliveryOfficerAnalytics error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

module.exports = { getDeliveryOfficerAnalytics };
