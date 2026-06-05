const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function backfillRankings() {
    console.log("Starting ranking backfill...");
    
    // Get all Verification, Delivery, and Recovery officers
    const verificationOfficers = await prisma.user.findMany({ where: { role: { name: { contains: 'Verification' } } } });
    const deliveryOfficers = await prisma.user.findMany({ where: { role: { name: { contains: 'Delivery' } } } });
    const recoveryOfficers = await prisma.user.findMany({ where: { role: { name: { contains: 'Recovery' } } } });

    console.log(`Found ${verificationOfficers.length} Verification Officers`);
    console.log(`Found ${deliveryOfficers.length} Delivery Officers`);
    console.log(`Found ${recoveryOfficers.length} Recovery Officers`);

    const now = new Date();
    // We will just update 'month', 'today', 'week' for the CURRENT time so the dashboard shows numbers right away.
    // To backfill for all past months, we need to iterate over orders.
    // Let's find the earliest order date.
    const firstOrder = await prisma.order.findFirst({
        orderBy: { updated_at: 'asc' }
    });

    if (!firstOrder) {
        console.log("No orders found. Exiting.");
        return;
    }

    const startYear = firstOrder.updated_at.getFullYear();
    const startMonth = firstOrder.updated_at.getMonth(); // 0-indexed

    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    // Generate all months from start to current
    const monthsToProcess = [];
    let y = startYear;
    let m = startMonth;
    while (y < currentYear || (y === currentYear && m <= currentMonth)) {
        monthsToProcess.push({ year: y, month: m });
        m++;
        if (m > 11) {
            m = 0;
            y++;
        }
    }

    console.log(`Processing ${monthsToProcess.length} months for historical data...`);

    // Verification Logic Helper
    const calcVerificationScore = (delivered, completed, cancelled, expired) => (completed * 10) + (delivered * 5) - (cancelled * 2) - (expired * 3);
    // Delivery Logic Helper
    const calcDeliveryScore = (delivered, completed, cancelled, expired) => (delivered * 15) + (completed * 5) - (cancelled * 2) - (expired * 3);
    // Recovery Logic Helper
    const calcRecoveryScore = (collectedCount, completed, cancelled, expired) => (collectedCount * 15) + (completed * 5) - (cancelled * 2) - (expired * 3);

    for (const { year, month } of monthsToProcess) {
        const start = new Date(year, month, 1, 0, 0, 0, 0);
        const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
        const dbMonth = month + 1; // 1-12

        // VERIFICATION
        for (const vo of verificationOfficers) {
            const orders = await prisma.order.findMany({
                where: { assigned_to_user_id: vo.id, updated_at: { gte: start, lte: end } }
            });

            if (orders.length === 0) continue;

            const uniqueCustomerIds = new Set(orders.map(o => o.customer_id).filter(Boolean));
            let delivered = 0, completed = 0, cancelled = 0, expired = 0, totalSales = 0;

            orders.forEach(o => {
                if (o.status === 'delivered') { delivered++; totalSales += (o.total_amount || 0); }
                if (o.status === 'completed' || o.status === 'approved') completed++;
                if (o.status === 'cancelled') cancelled++;
                if (o.status === 'expired') expired++;
            });

            const score = calcVerificationScore(delivered, completed, cancelled, expired);

            await prisma.verificationRanking.upsert({
                where: { officer_id_period_month_year: { officer_id: vo.id, period: 'month', month: dbMonth, year } },
                update: { unique_customers: uniqueCustomerIds.size, delivered_customers: delivered, completed_customers: completed, cancelled_customers: cancelled, expired_customers: expired, total_sales: totalSales, score, updated_at: now },
                create: { officer_id: vo.id, period: 'month', month: dbMonth, year, unique_customers: uniqueCustomerIds.size, delivered_customers: delivered, completed_customers: completed, cancelled_customers: cancelled, expired_customers: expired, total_sales: totalSales, score, updated_at: now }
            });
        }

        // DELIVERY
        for (const doff of deliveryOfficers) {
            const orders = await prisma.order.findMany({
                where: { delivery_officer_id: doff.id, updated_at: { gte: start, lte: end } }
            });

            if (orders.length === 0) continue;

            const uniqueCustomerIds = new Set(orders.map(o => o.customer_id).filter(Boolean));
            let delivered = 0, completed = 0, cancelled = 0, expired = 0, totalSales = 0;

            orders.forEach(o => {
                if (o.status === 'delivered') { delivered++; totalSales += (o.total_amount || 0); }
                if (o.status === 'completed') completed++;
                if (o.status === 'cancelled') cancelled++;
                if (o.status === 'expired') expired++;
            });

            const score = calcDeliveryScore(delivered, completed, cancelled, expired);

            await prisma.deliveryRanking.upsert({
                where: { officer_id_period_month_year: { officer_id: doff.id, period: 'month', month: dbMonth, year } },
                update: { unique_customers: uniqueCustomerIds.size, delivered_customers: delivered, completed_customers: completed, cancelled_customers: cancelled, expired_customers: expired, total_sales: totalSales, score, updated_at: now },
                create: { officer_id: doff.id, period: 'month', month: dbMonth, year, unique_customers: uniqueCustomerIds.size, delivered_customers: delivered, completed_customers: completed, cancelled_customers: cancelled, expired_customers: expired, total_sales: totalSales, score, updated_at: now }
            });
        }

        // RECOVERY
        for (const ro of recoveryOfficers) {
            const orders = await prisma.order.findMany({
                where: { recovery_officer_id: ro.id, updated_at: { gte: start, lte: end } }
            });
            const visits = await prisma.recoveryVisit.findMany({
                where: { officer_id: ro.id, visit_time: { gte: start, lte: end } }
            });

            if (orders.length === 0 && visits.length === 0) continue;

            const uniqueCustomerIds = new Set(orders.map(o => o.customer_id).filter(Boolean));
            let delivered = 0, completed = 0, cancelled = 0, expired = 0, totalSales = 0;

            orders.forEach(o => {
                if (o.status === 'delivered') delivered++;
                if (o.status === 'completed') completed++;
                if (o.status === 'cancelled') cancelled++;
                if (o.status === 'expired') expired++;
            });

            const collectedVisitsCount = visits.filter(v => v.payment_collected).length;
            let collectedAmount = 0;
            visits.forEach(v => {
                if (v.amount_collected) collectedAmount += v.amount_collected;
            });

            const score = calcRecoveryScore(collectedVisitsCount, completed, cancelled, expired);

            await prisma.recoveryRanking.upsert({
                where: { officer_id_period_month_year: { officer_id: ro.id, period: 'month', month: dbMonth, year } },
                update: { unique_customers: uniqueCustomerIds.size, delivered_customers: delivered, completed_customers: completed, cancelled_customers: cancelled, expired_customers: expired, total_sales: collectedAmount, score, updated_at: now },
                create: { officer_id: ro.id, period: 'month', month: dbMonth, year, unique_customers: uniqueCustomerIds.size, delivered_customers: delivered, completed_customers: completed, cancelled_customers: cancelled, expired_customers: expired, total_sales: collectedAmount, score, updated_at: now }
            });
        }
    }

    console.log("Historical Backfill Complete!");
}

backfillRankings()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
