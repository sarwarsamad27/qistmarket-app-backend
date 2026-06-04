const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Helper for current timestamp
const now = () => new Date();

/**
 * Identifies or creates a unique customer based on CNIC or Mobile Number.
 */
async function getOrCreateCustomer(orderId) {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
            verification: {
                include: {
                    purchaser: true
                }
            }
        }
    });

    if (!order) return null;

    const cnic = order.verification?.purchaser?.cnic_number;
    const mobile = order.whatsapp_number;
    const name = order.customer_name;

    let customer = null;

    // Search by CNIC first
    if (cnic) {
        customer = await prisma.customer.findUnique({ where: { cnic } });
    }

    // Then search by Mobile
    if (!customer && mobile) {
        customer = await prisma.customer.findUnique({ where: { mobile } });
    }

    if (!customer) {
        customer = await prisma.customer.create({
            data: {
                cnic: cnic || null,
                mobile: mobile,
                name: name,
                created_at: now(),   // ✅ explicit created_at
                updated_at: now()    // ✅ explicit updated_at
            }
        });
    } else {
        // Sync CNIC if it was previously missing
        if (cnic && !customer.cnic) {
            customer = await prisma.customer.update({
                where: { id: customer.id },
                data: {
                    cnic,
                    updated_at: now()   // ✅ explicit updated_at
                }
            });
        }
    }

    // Link order to customer
    await prisma.order.update({
        where: { id: orderId },
        data: { customer_id: customer.id }
    });

    return customer;
}

/**
 * Checks if a customer is a repeat customer.
 * A repeat customer is one who has at least one previous 'delivered' or 'completed' order.
 */
async function checkRepeatStatus(customerId, currentOrderId) {
    const previousSuccessOrder = await prisma.order.findFirst({
        where: {
            customer_id: customerId,
            id: { not: currentOrderId },
            status: { in: ['delivered', 'completed'] }
        }
    });

    return !!previousSuccessOrder;
}

/**
 * Recalculates ranking for a CSR for a specific period.
 */
async function updateCsrRanking(csrId, periodType = 'month') {
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
        const diff = nowDate.getDate() - day + (day === 0 ? -6 : 1); // Monday
        start = new Date(nowDate.setDate(diff)); start.setHours(0, 0, 0, 0);
        end = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
    }

    const orders = await prisma.order.findMany({
        where: {
            created_by_user_id: csrId,
            updated_at: { gte: start, lte: end }
        },
        include: {
            customer: true
        }
    });

    // Unique Customers logic
    const uniqueCustomerIds = new Set(orders.map(o => o.customer_id).filter(Boolean));
    const uniqueCustomersCount = uniqueCustomerIds.size;

    // Metrics based on UNIQUE CUSTOMERS
    const customerStats = {};

    orders.forEach(order => {
        const cid = order.customer_id || `null-${order.id}`;
        if (!customerStats[cid]) {
            customerStats[cid] = {
                delivered: false,
                completed: false,
                cancelled: false,
                expired: false,
                repeat: order.is_repeat_customer,
                sales: 0
            };
        }

        if (order.status === 'delivered') customerStats[cid].delivered = true;
        if (order.status === 'completed') customerStats[cid].completed = true;
        if (order.status === 'cancelled') customerStats[cid].cancelled = true;
        if (order.status === 'expired') customerStats[cid].expired = true;

        if (order.status === 'delivered') {
            customerStats[cid].sales += (order.total_amount || 0);
        }
    });

    let deliveredCount = 0;
    let completedCount = 0;
    let repeatCount = 0;
    let cancelledCount = 0;
    let expiredCount = 0;
    let totalSales = 0;

    Object.values(customerStats).forEach(stat => {
        if (stat.delivered) deliveredCount++;
        if (stat.completed) completedCount++;
        if (stat.repeat) repeatCount++;
        if (stat.cancelled) cancelledCount++;
        if (stat.expired) expiredCount++;
        totalSales += stat.sales;
    });

    // Fetch Solved Complaints for the CSR in the period
    const solvedComplaintsCount = await prisma.complaint.count({
        where: {
            assigned_to_user_id: csrId,
            status: 'Solved',
            updated_at: { gte: start, lte: end }
        }
    });

    // Scoring Formula
    const score = (deliveredCount * 10) + (repeatCount * 5) + (completedCount * 5) + (solvedComplaintsCount * 1) - (cancelledCount * 1) - (expiredCount * 3);

    // Fetch existing ranking to calculate trend
    const existingRanking = await prisma.csrRanking.findUnique({
        where: {
            csr_id_period_month_year: {
                csr_id: csrId,
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

    // Update Snapshot
    const ranking = await prisma.csrRanking.upsert({
        where: {
            csr_id_period_month_year: {
                csr_id: csrId,
                period: periodType,
                month: periodType === 'month' ? nowDate.getMonth() + 1 : 0,
                year: periodType === 'month' ? nowDate.getFullYear() : 0
            }
        },
        update: {
            unique_customers: uniqueCustomersCount,
            delivered_customers: deliveredCount,
            completed_customers: completedCount,
            repeat_customers: repeatCount,
            cancelled_customers: cancelledCount,
            expired_customers: expiredCount,
            total_sales: totalSales,
            score: score,
            trend: trend,
            updated_at: now()   // ✅ explicit updated_at
        },
        create: {
            csr_id: csrId,
            period: periodType,
            month: periodType === 'month' ? nowDate.getMonth() + 1 : 0,
            year: periodType === 'month' ? nowDate.getFullYear() : 0,
            unique_customers: uniqueCustomersCount,
            delivered_customers: deliveredCount,
            completed_customers: completedCount,
            repeat_customers: repeatCount,
            cancelled_customers: cancelledCount,
            expired_customers: expiredCount,
            total_sales: totalSales,
            score: score,
            trend: 0,
            updated_at: now()   // ✅ explicit updated_at (since model has only updated_at)
        }
    });

    return ranking;
}

/**
 * Calculates working days left in the current month, skipping Sundays.
 */
function getWorkingDaysLeftInMonth() {
    const nowDate = new Date();
    const lastDay = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0);

    let workingDays = 0;
    let current = new Date(nowDate);
    // Start from tomorrow
    current.setDate(current.getDate() + 1);

    while (current <= lastDay) {
        if (current.getDay() !== 0) { // Skip Sunday
            workingDays++;
        }
        current.setDate(current.getDate() + 1);
    }

    return workingDays || 1; // At least 1 to avoid division by zero
}

module.exports = {
    getOrCreateCustomer,
    checkRepeatStatus,
    updateCsrRanking,
    getWorkingDaysLeftInMonth
};