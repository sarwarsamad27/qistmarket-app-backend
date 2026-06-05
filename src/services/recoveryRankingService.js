const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const now = () => new Date();

async function updateRecoveryRanking(officerId, periodType = 'month') {
    const nowDate = new Date();
    let start, end;

    if (periodType === 'month') {
        start = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1, 0, 0, 0, 0);
        end = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (periodType === 'today') {
        start = new Date(nowDate); start.setHours(0, 0, 0, 0);
        end = new Date(nowDate); end.setHours(23, 59, 59, 999);
    } else if (periodType === 'week') {
        const day = nowDate.getDay();
        const diff = nowDate.getDate() - day + (day === 0 ? -6 : 1);
        start = new Date(nowDate.setDate(diff)); start.setHours(0, 0, 0, 0);
        end = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
    }

    const orders = await prisma.order.findMany({
        where: {
            recovery_officer_id: officerId,
            updated_at: { gte: start, lte: end }
        }
    });

    const uniqueCustomerIds = new Set(orders.map(o => o.customer_id).filter(Boolean));
    const uniqueCustomersCount = uniqueCustomerIds.size;

    let deliveredCount = 0;
    let completedCount = 0;
    let cancelledCount = 0;
    let expiredCount = 0;
    let totalSales = 0;

    orders.forEach(order => {
        if (order.status === 'delivered') {
            deliveredCount++;
        }
        if (order.status === 'completed') completedCount++;
        if (order.status === 'cancelled') cancelledCount++;
        if (order.status === 'expired') expiredCount++;
    });

    // Also factor in recovery visits
    const visits = await prisma.recoveryVisit.findMany({
        where: {
            officer_id: officerId,
            visit_time: { gte: start, lte: end }
        }
    });

    const collectedVisitsCount = visits.filter(v => v.payment_collected).length;
    let collectedAmount = 0;
    visits.forEach(v => {
        if (v.amount_collected) collectedAmount += v.amount_collected;
    });

    const score = (collectedVisitsCount * 15) + (completedCount * 5) - (cancelledCount * 2) - (expiredCount * 3);

    const existingRanking = await prisma.recoveryRanking.findUnique({
        where: {
            officer_id_period_month_year: {
                officer_id: officerId,
                period: periodType,
                month: periodType === 'month' ? nowDate.getMonth() + 1 : 0,
                year: periodType === 'month' ? nowDate.getFullYear() : 0
            }
        }
    });

    let trend = existingRanking?.trend || 0;
    if (existingRanking && score !== existingRanking.score) {
        trend = score > existingRanking.score ? 1 : -1;
    }

    const ranking = await prisma.recoveryRanking.upsert({
        where: {
            officer_id_period_month_year: {
                officer_id: officerId,
                period: periodType,
                month: periodType === 'month' ? nowDate.getMonth() + 1 : 0,
                year: periodType === 'month' ? nowDate.getFullYear() : 0
            }
        },
        update: {
            unique_customers: uniqueCustomersCount,
            delivered_customers: deliveredCount,
            completed_customers: completedCount,
            cancelled_customers: cancelledCount,
            expired_customers: expiredCount,
            total_sales: collectedAmount, // Reusing total_sales for recovered amount
            score: score,
            trend: trend,
            updated_at: now()
        },
        create: {
            officer_id: officerId,
            period: periodType,
            month: periodType === 'month' ? nowDate.getMonth() + 1 : 0,
            year: periodType === 'month' ? nowDate.getFullYear() : 0,
            unique_customers: uniqueCustomersCount,
            delivered_customers: deliveredCount,
            completed_customers: completedCount,
            cancelled_customers: cancelledCount,
            expired_customers: expiredCount,
            total_sales: collectedAmount,
            score: score,
            trend: 0,
            updated_at: now()
        }
    });

    return ranking;
}

module.exports = { updateRecoveryRanking };
