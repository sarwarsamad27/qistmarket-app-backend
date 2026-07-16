const prisma = require('../../lib/prisma');

/**
 * getOutletPerformanceSummary
 * Per-outlet order-status breakdown + pending cash-in-hand, for the
 * Admin "Outlets Management" page. Not scoped to any single outlet —
 * Admin/Super Admin see every outlet side by side.
 */
const getOutletPerformanceSummary = async (req, res) => {
    try {
        const [outlets, statusAgg, pendingCashTxns] = await Promise.all([
            prisma.outlet.findMany({ select: { id: true, name: true, code: true, type: true, status: true } }),
            prisma.order.groupBy({ by: ['outlet_id', 'status'], _count: { _all: true } }),
            prisma.officerTransaction.findMany({
                where: { type: 'credit', status: 'pending' },
                select: { amount: true, officer: { select: { outlet_id: true } } },
            }),
        ]);

        const outletMap = {};
        for (const o of outlets) {
            outletMap[o.id] = {
                outlet_id: o.id,
                outlet_name: o.name,
                outlet_code: o.code,
                type: o.type,
                status: o.status,
                totalOrders: 0,
                statusBreakdown: {},
                pendingCash: 0,
            };
        }

        for (const row of statusAgg) {
            const entry = outletMap[row.outlet_id];
            if (!entry) continue;
            entry.totalOrders += row._count._all;
            entry.statusBreakdown[row.status] = row._count._all;
        }

        for (const t of pendingCashTxns) {
            const entry = outletMap[t.officer?.outlet_id];
            if (!entry) continue;
            entry.pendingCash += t.amount;
        }

        res.json({ success: true, data: Object.values(outletMap) });
    } catch (error) {
        console.error('getOutletPerformanceSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const currentPeriod = () => {
    const now = new Date();
    return { period: 'month', month: now.getMonth() + 1, year: now.getFullYear() };
};

/**
 * getUnifiedRankings
 * Combines the four department ranking tables (CSR / Verification /
 * Delivery / Recovery) — each already maintained by its own portal's
 * ranking service — into one response for the Admin "Rankings &
 * Leaderboards" page.
 */
const tierFor = (score) => (score >= 1500 ? 'Gold' : score >= 1000 ? 'Silver' : 'Bronze');

const avgMinutes = (rows) => {
    const durations = rows.filter((r) => r.start_time && r.end_time).map((r) => (new Date(r.end_time) - new Date(r.start_time)) / 60000);
    if (durations.length === 0) return null;
    return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
};

const getUnifiedRankings = async (req, res) => {
    try {
        const { period, month, year } = currentPeriod();
        const userInclude = {
            select: { full_name: true, username: true, outlet: { select: { name: true } } },
        };

        const [csr, verification, delivery, recovery] = await Promise.all([
            prisma.csrRanking.findMany({ where: { period, month, year }, orderBy: { rank: 'asc' }, include: { user: userInclude } }),
            prisma.verificationRanking.findMany({ where: { period, month, year }, orderBy: { rank: 'asc' }, include: { user: userInclude } }),
            prisma.deliveryRanking.findMany({ where: { period, month, year }, orderBy: { rank: 'asc' }, include: { user: userInclude } }),
            prisma.recoveryRanking.findMany({ where: { period, month, year }, orderBy: { rank: 'asc' }, include: { user: userInclude } }),
        ]);

        const shape = (rows) => rows.map((r) => ({
            id: r.id,
            officer_id: r.officer_id ?? r.csr_id,
            full_name: r.user?.full_name || 'Unknown',
            username: r.user?.username || '',
            outlet_name: r.user?.outlet?.name || 'Unassigned',
            score: r.score,
            rank: r.rank,
            trend: r.trend,
            total_sales: r.total_sales,
            unique_customers: r.unique_customers,
            delivered_customers: r.delivered_customers,
            tier: tierFor(r.score),
        }));

        const csrShaped = shape(csr);
        const verificationShaped = shape(verification);
        const deliveryShaped = shape(delivery);
        const recoveryShaped = shape(recovery);

        // Supplementary KPIs — computed from the underlying source tables
        // (not stored on the ranking rows themselves) for the top-10 rows
        // already returned per board, so this stays a bounded query volume.
        const startOfMonth = new Date(year, month - 1, 1);
        const endOfMonth = new Date(year, month, 1);

        await Promise.all([
            ...verificationShaped.slice(0, 10).map(async (row) => {
                const verifications = await prisma.verification.findMany({
                    where: { verification_officer_id: row.officer_id, created_at: { gte: startOfMonth, lt: endOfMonth } },
                    select: { status: true, start_time: true, end_time: true },
                });
                row.total_verifications = verifications.length;
                row.approved_verifications = verifications.filter((v) => v.status === 'approved' || v.status === 'completed').length;
                row.rejected_verifications = verifications.filter((v) => v.status === 'rejected').length;
                row.avg_verification_minutes = avgMinutes(verifications);
            }),
            ...deliveryShaped.slice(0, 10).map(async (row) => {
                const deliveries = await prisma.delivery.findMany({
                    where: { delivery_agent_id: row.officer_id, created_at: { gte: startOfMonth, lt: endOfMonth } },
                    select: { status: true, start_time: true, end_time: true },
                });
                row.successful_deliveries = deliveries.filter((d) => d.status === 'delivered' || d.status === 'completed').length;
                row.failed_deliveries = deliveries.filter((d) => d.status === 'cancelled' || d.status === 'failed').length;
                row.avg_delivery_minutes = avgMinutes(deliveries);
            }),
            ...recoveryShaped.slice(0, 10).map(async (row) => {
                const visits = await prisma.recoveryVisit.findMany({
                    where: { officer_id: row.officer_id, visit_time: { gte: startOfMonth, lt: endOfMonth } },
                    select: { payment_collected: true, amount_collected: true },
                });
                row.visit_count = visits.length;
                row.recovery_amount = visits.reduce((s, v) => s + (v.amount_collected || 0), 0);
                row.missed_visits = visits.filter((v) => !v.payment_collected).length;
            }),
            ...csrShaped.map(async (row) => {
                row.conversion_rate = row.unique_customers > 0 ? Math.round((row.delivered_customers / row.unique_customers) * 1000) / 10 : 0;
            }),
        ]);

        res.json({
            success: true,
            data: {
                period: { period, month, year },
                csr: csrShaped,
                verification: verificationShaped,
                delivery: deliveryShaped,
                recovery: recoveryShaped,
            },
        });
    } catch (error) {
        console.error('getUnifiedRankings error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getOutletRankings
 * Computed on-the-fly (not persisted, unlike officer rankings) — ranks
 * outlets by a blended score of this month's sales, recovery %, and
 * installment on-time performance. No new schema; the four officer
 * ranking tables already set the precedent that "ranking" doesn't
 * require a dedicated always-on service for every board.
 */
const getOutletRankings = async (req, res) => {
    try {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const outlets = await prisma.outlet.findMany({ where: { type: { not: 'warehouse' } }, select: { id: true, name: true, code: true } });
        const orders = await prisma.order.findMany({
            where: { outlet_id: { in: outlets.map((o) => o.id) }, status: { notIn: ['Cancelled', 'Rejected'] }, created_at: { gte: startOfMonth } },
            select: { outlet_id: true, total_amount: true, installment_ledger: { select: { ledger_rows: true } } },
        });

        const stats = {};
        for (const o of outlets) stats[o.id] = { outlet_id: o.id, outlet_name: o.name, outlet_code: o.code, totalSales: 0, dueAmount: 0, recoveredAmount: 0, onTimeCount: 0, lateCount: 0 };

        for (const order of orders) {
            const entry = stats[order.outlet_id];
            if (!entry) continue;
            entry.totalSales += order.total_amount || 0;

            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            for (const row of rows) {
                const amount = parseFloat(row.amount || row.dueAmount || 0);
                entry.dueAmount += amount;
                if (row.status === 'paid') {
                    entry.recoveredAmount += amount;
                    if (row.paid_at && row.dueDate && new Date(row.paid_at) <= new Date(row.dueDate)) entry.onTimeCount += 1;
                    else entry.lateCount += 1;
                }
            }
        }

        const ranked = Object.values(stats).map((s) => {
            const recoveryPct = s.dueAmount > 0 ? (s.recoveredAmount / s.dueAmount) * 100 : 0;
            const onTimePct = s.onTimeCount + s.lateCount > 0 ? (s.onTimeCount / (s.onTimeCount + s.lateCount)) * 100 : 0;
            // Blended score: sales scaled down + recovery% + on-time% weighted evenly
            const score = Math.round(s.totalSales / 1000 + recoveryPct * 5 + onTimePct * 5);
            return { ...s, recoveryPercentage: Math.round(recoveryPct * 10) / 10, onTimePercentage: Math.round(onTimePct * 10) / 10, score };
        }).sort((a, b) => b.score - a.score)
          .map((s, idx) => ({ ...s, rank: idx + 1, tier: tierFor(s.score) }));

        res.json({ success: true, data: ranked });
    } catch (error) {
        console.error('getOutletRankings error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getMissedRecoveryTracking
 * Recovery officers with orders assigned to them that have zero
 * RecoveryVisit rows in the last 14 days — a proxy for "missed"
 * follow-up, since there's no explicit "missed visit" flag in the schema.
 */
const getMissedRecoveryTracking = async (req, res) => {
    try {
        const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

        const assignedOrders = await prisma.order.findMany({
            where: { recovery_officer_id: { not: null }, status: { notIn: ['Cancelled', 'Rejected', 'Completed'] }, is_delivered: true },
            select: {
                id: true, order_ref: true, customer_name: true, recovery_officer_id: true,
                recovery_officer: { select: { full_name: true } },
                recovery_visits: { where: { visit_time: { gte: cutoff } }, select: { id: true }, take: 1 },
            },
        });

        const missed = assignedOrders
            .filter((o) => o.recovery_visits.length === 0)
            .map((o) => ({ order_id: o.id, order_ref: o.order_ref, customer_name: o.customer_name, officer_id: o.recovery_officer_id, officer_name: o.recovery_officer?.full_name || 'Unassigned' }));

        res.json({ success: true, data: { count: missed.length, items: missed } });
    } catch (error) {
        console.error('getMissedRecoveryTracking error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getProductSalesReport
 * Product-wise sales + top-selling products, grouped from Order.product_name
 * on delivered orders. Brand-wise sales isn't included — there's no brand
 * field anywhere on Order or OutletInventory to group by.
 */
const getProductSalesReport = async (req, res) => {
    try {
        const orders = await prisma.order.groupBy({
            by: ['product_name'],
            where: { status: { in: ['delivered', 'completed'] } },
            _count: { _all: true },
            _sum: { total_amount: true },
        });

        const products = orders
            .map((o) => ({ product_name: o.product_name, unitsSold: o._count._all, totalRevenue: o._sum.total_amount || 0 }))
            .sort((a, b) => b.unitsSold - a.unitsSold);

        res.json({ success: true, data: { products, topSelling: products.slice(0, 10) } });
    } catch (error) {
        console.error('getProductSalesReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getInstallmentStatusCounts
 * Active vs. closed (all rows paid) installment counts, company-wide —
 * derived from ledger_rows, no schema change (no stored "closed" flag).
 */
const getInstallmentStatusCounts = async (req, res) => {
    try {
        const orders = await prisma.order.findMany({
            where: { status: { notIn: ['Cancelled', 'Rejected'] }, is_delivered: true },
            select: { installment_ledger: { select: { ledger_rows: true } } },
        });

        let active = 0;
        let closed = 0;
        for (const order of orders) {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            if (rows.length === 0) continue;
            const allPaid = rows.every((r) => r.status === 'paid');
            if (allPaid) closed += 1;
            else active += 1;
        }

        res.json({ success: true, data: { active, closed, total: active + closed } });
    } catch (error) {
        console.error('getInstallmentStatusCounts error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getAttendanceMonitoring
 * Today's attendance rolled up per outlet, via Employee.outlet_id — HR's
 * EmployeeAttendance table already exists; this is a new outlet-grouped
 * view over it for the Admin Outlets page.
 */
const getAttendanceMonitoring = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [employees, attendanceToday] = await Promise.all([
            prisma.employee.findMany({ where: { portal_active: true }, select: { id: true, outlet_id: true } }),
            prisma.employeeAttendance.findMany({ where: { date: today }, select: { employee_id: true, status: true } }),
        ]);

        const attendanceByEmployee = Object.fromEntries(attendanceToday.map((a) => [a.employee_id, a.status]));
        const outlets = await prisma.outlet.findMany({ select: { id: true, name: true } });
        const outletMap = {};
        for (const o of outlets) outletMap[o.id] = { outlet_id: o.id, outlet_name: o.name, totalStaff: 0, present: 0, absent: 0, notMarked: 0 };

        for (const emp of employees) {
            const entry = outletMap[emp.outlet_id];
            if (!entry) continue;
            entry.totalStaff += 1;
            const status = attendanceByEmployee[emp.id];
            if (!status) entry.notMarked += 1;
            else if (status === 'present') entry.present += 1;
            else entry.absent += 1;
        }

        res.json({ success: true, data: Object.values(outletMap).filter((o) => o.totalStaff > 0) });
    } catch (error) {
        console.error('getAttendanceMonitoring error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getPayrollSummary
 * Company-wide payroll totals by month — PayrollSlip only had a
 * per-employee endpoint (GET /api/hr/employees/:id/payroll) before this;
 * this is the missing company-wide rollup for the Admin Reports Hub.
 */
const getPayrollSummary = async (req, res) => {
    try {
        const slips = await prisma.payrollSlip.findMany({
            orderBy: [{ year: 'desc' }, { month: 'desc' }],
            include: { employee: { select: { full_name: true, department: true } } },
            take: 200,
        });

        const summary = {};
        for (const s of slips) {
            const key = `${s.year}-${String(s.month).padStart(2, '0')}`;
            if (!summary[key]) summary[key] = { month: key, totalNetPayable: 0, employeeCount: 0, paidCount: 0 };
            summary[key].totalNetPayable += s.net_payable;
            summary[key].employeeCount += 1;
            if (s.status === 'paid') summary[key].paidCount += 1;
        }

        res.json({
            success: true,
            data: {
                monthly: Object.values(summary),
                slips: slips.map((s) => ({ id: s.id, employee_name: s.employee?.full_name || 'Unknown', department: s.employee?.department || '—', month: s.month, year: s.year, net_payable: s.net_payable, status: s.status })),
            },
        });
    } catch (error) {
        console.error('getPayrollSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getDeliveryManagementOverview
 * Lightweight company-wide delivery aggregate — status counts, today's
 * total, and a per-officer breakdown. Deliberately NOT a port of the
 * single-officer getDeliveryOfficerAnalytics (deliveryAnalyticsController.js,
 * ~250 lines) — that function is scoped and shaped for one officer's own
 * dashboard and is too large/risky to globalize wholesale.
 */
const getDeliveryManagementOverview = async (req, res) => {
    try {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const [statusAgg, todayCount, officerAgg] = await Promise.all([
            prisma.delivery.groupBy({ by: ['status'], _count: { _all: true } }),
            prisma.delivery.count({ where: { created_at: { gte: startOfDay } } }),
            prisma.delivery.groupBy({ by: ['delivery_agent_id', 'status'], _count: { _all: true } }),
        ]);

        const officerIds = [...new Set(officerAgg.map((o) => o.delivery_agent_id).filter(Boolean))];
        const officers = officerIds.length
            ? await prisma.user.findMany({ where: { id: { in: officerIds } }, select: { id: true, full_name: true, username: true, outlet: { select: { name: true } } } })
            : [];
        const officerById = Object.fromEntries(officers.map((o) => [o.id, o]));

        const officerMap = {};
        for (const row of officerAgg) {
            const key = row.delivery_agent_id;
            if (!key) continue;
            if (!officerMap[key]) {
                officerMap[key] = {
                    officer_id: key,
                    full_name: officerById[key]?.full_name || 'Unknown',
                    username: officerById[key]?.username || '',
                    outlet_name: officerById[key]?.outlet?.name || 'Unassigned',
                    total: 0,
                    statusBreakdown: {},
                };
            }
            officerMap[key].total += row._count._all;
            officerMap[key].statusBreakdown[row.status] = row._count._all;
        }

        res.json({
            success: true,
            data: {
                statusBreakdown: Object.fromEntries(statusAgg.map((s) => [s.status, s._count._all])),
                totalToday: todayCount,
                officerWise: Object.values(officerMap).sort((a, b) => b.total - a.total),
            },
        });
    } catch (error) {
        console.error('getDeliveryManagementOverview error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * syncBadges
 * Admin/Super Admin-triggered (not an auto-cron, to avoid adding a new
 * background job to a live system). Reads the same current-month ranking
 * rows getUnifiedRankings already reads and upserts a persisted Badge row
 * for rank <= 3 per department, so achievements survive past the current
 * ranking period instead of being purely derived/ephemeral.
 */
const syncBadges = async (req, res) => {
    try {
        const { period, month, year } = currentPeriod();
        const departments = [
            { key: 'csr', model: prisma.csrRanking },
            { key: 'verification', model: prisma.verificationRanking },
            { key: 'delivery', model: prisma.deliveryRanking },
            { key: 'recovery', model: prisma.recoveryRanking },
        ];

        let awarded = 0;
        for (const dept of departments) {
            const topRows = await dept.model.findMany({ where: { period, month, year, rank: { lte: 3 } } });
            for (const row of topRows) {
                const badge_type = row.rank === 1 ? 'champion' : 'top_performer';
                await prisma.badge.upsert({
                    where: { user_id_department_period_month_year: { user_id: row.officer_id ?? row.csr_id, department: dept.key, period, month, year } },
                    update: { badge_type, awarded_at: new Date() },
                    create: { user_id: row.officer_id ?? row.csr_id, department: dept.key, badge_type, period, month, year },
                });
                awarded += 1;
            }
        }

        res.json({ success: true, message: `Synced ${awarded} badge(s) for ${month}/${year}.`, data: { awarded } });
    } catch (error) {
        console.error('syncBadges error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getBadges
 * Badge history — most recent first, with the user's name/outlet resolved.
 */
const getBadges = async (req, res) => {
    try {
        const badges = await prisma.badge.findMany({
            orderBy: [{ year: 'desc' }, { month: 'desc' }, { awarded_at: 'desc' }],
            include: { user: { select: { full_name: true, username: true, outlet: { select: { name: true } } } } },
            take: 100,
        });

        res.json({
            success: true,
            data: badges.map((b) => ({
                id: b.id,
                full_name: b.user?.full_name || 'Unknown',
                username: b.user?.username || '',
                outlet_name: b.user?.outlet?.name || 'Unassigned',
                department: b.department,
                badge_type: b.badge_type,
                month: b.month,
                year: b.year,
                awarded_at: b.awarded_at,
            })),
        });
    } catch (error) {
        console.error('getBadges error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getOutletStaffList
 * outletController.getOutletOfficers reads req.user.outlet_id directly
 * (no query-param fallback), so it only works for outlet-logged-in users
 * — not reusable for Admin, whose token has no outlet_id. This is the
 * Admin-facing equivalent: any outlet, any role, via ?outlet_id=.
 */
const getOutletStaffList = async (req, res) => {
    const { outlet_id } = req.query;
    if (!outlet_id) return res.status(400).json({ success: false, message: 'outlet_id is required.' });

    try {
        const staff = await prisma.user.findMany({
            where: { outlet_id: parseInt(outlet_id) },
            select: { id: true, full_name: true, username: true, phone: true, status: true, is_online: true, role: { select: { name: true } } },
            orderBy: { full_name: 'asc' },
        });

        res.json({ success: true, data: staff.map((s) => ({ id: s.id, full_name: s.full_name, username: s.username, phone: s.phone, status: s.status, is_online: s.is_online, role: s.role?.name || 'Unknown' })) });
    } catch (error) {
        console.error('getOutletStaffList error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getOutletPerformanceSummary,
    getUnifiedRankings,
    getDeliveryManagementOverview,
    syncBadges,
    getBadges,
    getOutletRankings,
    getMissedRecoveryTracking,
    getProductSalesReport,
    getInstallmentStatusCounts,
    getAttendanceMonitoring,
    getPayrollSummary,
    getOutletStaffList,
};
