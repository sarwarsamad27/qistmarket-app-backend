const prisma = require('../../lib/prisma');
const { getOutletFilter } = require('../utils/outletFilter');
const { getDateRangeFilter } = require('../utils/dateRangeUtils');

const pct = (part, whole) => (whole > 0 ? Number(((part / whole) * 100).toFixed(2)) : 0);

/**
 * getCashInHandOverview
 * Global (or single-outlet, via ?outletId=) pending cash-in-hand, sourced
 * from the same OfficerTransaction ledger the mobile app's Cash In Hand
 * screen reads from (officerTransactionUtils.createOfficerTransaction) —
 * so the Transaction ID (TXN-...) and Submission Ref (SUB-...) shown here
 * are the exact same real values an officer sees on their device, not a
 * synthetic ID derived from an internal row number.
 * "Pending cash in hand" = credit transactions not yet submitted/verified
 * (officerTransactionUtils defaults new credits to status "pending").
 */
const getCashInHandOverview = async (req, res) => {
    const outletFilter = getOutletFilter(req);

    try {
        const transactions = await prisma.officerTransaction.findMany({
            where: {
                type: 'credit',
                status: 'pending',
                ...(outletFilter.outlet_id ? { officer: { outlet_id: outletFilter.outlet_id } } : {}),
            },
            include: {
                officer: { select: { id: true, full_name: true, username: true, phone: true, role: { select: { name: true } }, outlet: { select: { id: true, name: true, code: true } } } },
            },
            orderBy: { transaction_date: 'desc' },
        });

        const outletMap = {};
        const officerMap = {};
        let totalPending = 0;

        for (const t of transactions) {
            totalPending += t.amount;

            const outletKey = t.officer?.outlet?.id ?? 'unassigned';
            if (!outletMap[outletKey]) {
                outletMap[outletKey] = { outlet_id: t.officer?.outlet?.id ?? null, outlet_name: t.officer?.outlet?.name || 'Unassigned', pending: 0, count: 0 };
            }
            outletMap[outletKey].pending += t.amount;
            outletMap[outletKey].count += 1;

            const officerKey = t.officer_id ?? 'unassigned';
            if (!officerMap[officerKey]) {
                officerMap[officerKey] = { officer_id: t.officer_id, officer_name: t.officer?.full_name || 'Unassigned', role: t.officer?.role?.name || 'N/A', pending: 0, count: 0 };
            }
            officerMap[officerKey].pending += t.amount;
            officerMap[officerKey].count += 1;
        }

        res.json({
            success: true,
            data: {
                totalPending,
                entries: transactions.map((t) => ({
                    id: t.id,
                    transaction_id: t.transaction_id,
                    submission_ref: t.submission_ref,
                    order_ref: t.order_ref,
                    amount: t.amount,
                    balance: t.amount,
                    type: t.type,
                    status: t.status,
                    description: t.description,
                    payment_method: t.payment_method || 'cash',
                    transaction_date: t.transaction_date,
                    officer: t.officer ? { id: t.officer.id, full_name: t.officer.full_name, username: t.officer.username, phone: t.officer.phone, role: t.officer.role?.name || 'N/A' } : null,
                    outlet: t.officer?.outlet ? { id: t.officer.outlet.id, name: t.officer.outlet.name, code: t.officer.outlet.code } : null,
                })),
                outletWise: Object.values(outletMap),
                officerWise: Object.values(officerMap),
            },
        });
    } catch (error) {
        console.error('getCashInHandOverview error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getGlobalExpenseSummary
 * Same shape as expenseController.getExpenseSummary but without the
 * outlet_id guard, plus an outlet-wise breakdown.
 */
const getGlobalExpenseSummary = async (req, res) => {
    const outletFilter = getOutletFilter(req);

    const nowDate = new Date();
    const startOfToday = new Date(nowDate.setHours(0, 0, 0, 0));
    const startOfMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);

    try {
        const [todayExpenses, monthExpenses, categorySummary, outletSummary] = await Promise.all([
            prisma.expenseVoucher.aggregate({
                where: { ...outletFilter, date: { gte: startOfToday } },
                _sum: { total_amount: true },
            }),
            prisma.expenseVoucher.aggregate({
                where: { ...outletFilter, date: { gte: startOfMonth } },
                _sum: { total_amount: true },
            }),
            prisma.expenseItem.groupBy({
                by: ['category'],
                where: { voucher: outletFilter },
                _sum: { amount: true },
                orderBy: { _sum: { amount: 'desc' } },
                take: 5,
            }),
            prisma.expenseVoucher.groupBy({
                by: ['outlet_id'],
                where: { ...outletFilter, date: { gte: startOfMonth } },
                _sum: { total_amount: true },
            }),
        ]);

        const outletIds = outletSummary.map((o) => o.outlet_id).filter(Boolean);
        const outlets = outletIds.length
            ? await prisma.outlet.findMany({ where: { id: { in: outletIds } }, select: { id: true, name: true } })
            : [];
        const outletNameById = Object.fromEntries(outlets.map((o) => [o.id, o.name]));

        res.json({
            success: true,
            summary: {
                today: todayExpenses._sum.total_amount || 0,
                thisMonth: monthExpenses._sum.total_amount || 0,
                topCategories: categorySummary.map((c) => ({ category: c.category, amount: c._sum.amount })),
                outletWise: outletSummary.map((o) => ({
                    outlet_id: o.outlet_id,
                    outlet_name: outletNameById[o.outlet_id] || 'Unassigned',
                    thisMonth: o._sum.total_amount || 0,
                })),
            },
        });
    } catch (error) {
        console.error('getGlobalExpenseSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getGlobalVendorPayables
 * Same shape as vendorController.getVendorSummary but explicitly global-aware
 * (adds a per-outlet breakdown on top of the per-vendor one).
 */
const getGlobalVendorPayables = async (req, res) => {
    const outletFilter = getOutletFilter(req);

    try {
        const [vendorSummary, outletSummary] = await Promise.all([
            prisma.vendorPurchase.groupBy({
                by: ['vendor_name', 'vendor_id'],
                where: outletFilter,
                _sum: { total_amount: true, paid_amount: true, balance: true },
            }),
            prisma.vendorPurchase.groupBy({
                by: ['outlet_id'],
                where: outletFilter,
                _sum: { balance: true },
            }),
        ]);

        const outletIds = outletSummary.map((o) => o.outlet_id).filter(Boolean);
        const outlets = outletIds.length
            ? await prisma.outlet.findMany({ where: { id: { in: outletIds } }, select: { id: true, name: true } })
            : [];
        const outletNameById = Object.fromEntries(outlets.map((o) => [o.id, o.name]));

        const totalPayable = vendorSummary.reduce((acc, v) => acc + (v._sum.balance || 0), 0);

        res.json({
            success: true,
            data: {
                totalPayable,
                vendorWise: vendorSummary.map((s) => ({
                    vendor_name: s.vendor_name,
                    vendor_id: s.vendor_id,
                    total_amount: s._sum.total_amount || 0,
                    paid_amount: s._sum.paid_amount || 0,
                    balance: s._sum.balance || 0,
                })),
                outletWise: outletSummary.map((o) => ({
                    outlet_id: o.outlet_id,
                    outlet_name: outletNameById[o.outlet_id] || 'Unassigned',
                    payable: o._sum.balance || 0,
                })),
            },
        });
    } catch (error) {
        console.error('getGlobalVendorPayables error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getRecoveryAnalytics
 * Recovery percentage + outlet-wise/officer-wise due-vs-recovered breakdown
 * for a date range. No existing endpoint aggregates across officers/outlets
 * (recoveryController's functions are scoped to req.user.id).
 */
const getRecoveryAnalytics = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { range = 'Month', startDate, endDate } = req.query;
    const dateFilter = getDateRangeFilter(range, startDate, endDate);

    try {
        const orders = await prisma.order.findMany({
            where: { ...outletFilter, status: { notIn: ['Cancelled', 'Rejected'] } },
            include: {
                installment_ledger: true,
                outlet: { select: { id: true, name: true } },
                recovery_officer: { select: { id: true, full_name: true } },
            },
        });

        const outletMap = {};
        const officerMap = {};
        let totalDue = 0;
        let totalRecovered = 0;

        for (const order of orders) {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];

            const outletKey = order.outlet_id ?? 'unassigned';
            if (!outletMap[outletKey]) {
                outletMap[outletKey] = { outlet_id: order.outlet_id, outlet_name: order.outlet?.name || 'Unassigned', due: 0, recovered: 0 };
            }

            const officerKey = order.recovery_officer_id ?? 'unassigned';
            if (!officerMap[officerKey]) {
                officerMap[officerKey] = { officer_id: order.recovery_officer_id, officer_name: order.recovery_officer?.full_name || 'Unassigned', due: 0, recovered: 0 };
            }

            for (const row of rows) {
                const dueDate = row.dueDate ? new Date(row.dueDate) : null;
                if (!dueDate || !dateFilter || dueDate < dateFilter.gte || dueDate >= dateFilter.lt) continue;

                const amount = parseFloat(row.amount || row.dueAmount || 0);
                totalDue += amount;
                outletMap[outletKey].due += amount;
                officerMap[officerKey].due += amount;

                if (row.status === 'paid') {
                    totalRecovered += amount;
                    outletMap[outletKey].recovered += amount;
                    officerMap[officerKey].recovered += amount;
                }
            }
        }

        res.json({
            success: true,
            data: {
                range,
                dateRange: dateFilter,
                totalDue,
                totalRecovered,
                recoveryPercentage: pct(totalRecovered, totalDue),
                outletWise: Object.values(outletMap).map((o) => ({ ...o, recoveryPercentage: pct(o.recovered, o.due) })),
                officerWise: Object.values(officerMap).map((o) => ({ ...o, recoveryPercentage: pct(o.recovered, o.due) })),
            },
        });
    } catch (error) {
        console.error('getRecoveryAnalytics error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getDashboardSummary
 * Top-tile numbers for the Accounts dashboard landing page, composed from
 * the functions above plus a couple of direct light queries, so the
 * frontend doesn't have to fire 6+ requests on first load.
 */
const getDashboardSummary = async (req, res) => {
    const outletFilter = getOutletFilter(req);

    const nowDate = new Date();
    const startOfToday = new Date(nowDate.setHours(0, 0, 0, 0));

    try {
        const [cashPending, onlineToday, expenseSummary, vendorPayables, receivables, bankBalance] = await Promise.all([
            prisma.officerTransaction.aggregate({
                where: {
                    type: 'credit',
                    status: 'pending',
                    ...(outletFilter.outlet_id ? { officer: { outlet_id: outletFilter.outlet_id } } : {}),
                },
                _sum: { amount: true },
            }),
            prisma.orderPayment.aggregate({
                where: {
                    paidAt: { gte: startOfToday },
                    paymentMethod: { not: 'Cash' },
                    ...(outletFilter.outlet_id ? { order: { outlet_id: outletFilter.outlet_id } } : {}),
                },
                _sum: { amount: true },
            }),
            prisma.expenseVoucher.aggregate({
                where: { ...outletFilter, date: { gte: startOfToday } },
                _sum: { total_amount: true },
            }),
            prisma.vendorPurchase.aggregate({
                where: outletFilter,
                _sum: { balance: true },
            }),
            prisma.order.findMany({
                where: { ...outletFilter, status: { notIn: ['Cancelled', 'Rejected'] } },
                include: { installment_ledger: true },
            }),
            prisma.bankAccount.aggregate({
                where: { is_active: true, ...(outletFilter.outlet_id ? { outlet_id: outletFilter.outlet_id } : {}) },
                _sum: { current_balance: true },
            }),
        ]);

        const totalReceivable = receivables.reduce((acc, order) => {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            const totalPaid = rows.filter((r) => r.status === 'paid').reduce((a, r) => a + (r.amount || 0), 0);
            const balance = order.total_amount - totalPaid;
            return balance > 0 ? acc + balance : acc;
        }, 0);

        res.json({
            success: true,
            data: {
                totalCashInHand: cashPending._sum.amount || 0,
                pendingCashInHand: cashPending._sum.amount || 0,
                onlinePaymentsToday: onlineToday._sum.amount || 0,
                todaysExpense: expenseSummary._sum.total_amount || 0,
                vendorPayables: vendorPayables._sum.balance || 0,
                customerReceivables: totalReceivable,
                bankBalance: bankBalance._sum.current_balance || 0,
            },
        });
    } catch (error) {
        console.error('getDashboardSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const AGING_BUCKETS = ['0-30', '31-60', '61-90', '90+'];

const bucketFor = (daysOverdue) => {
    if (daysOverdue <= 30) return '0-30';
    if (daysOverdue <= 60) return '31-60';
    if (daysOverdue <= 90) return '61-90';
    return '90+';
};

const emptyBuckets = () => ({ '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 });

/**
 * getInstallmentAging
 * Buckets every outstanding (unpaid/partial) installment row by how many
 * days past its due date it is, with outlet-wise and officer-wise breakdowns.
 * No existing endpoint does this — closest precedents (getDueOverdueInstallments,
 * getRecoveryReport) return raw lists without day-bucketed aggregation.
 */
const getInstallmentAging = async (req, res) => {
    const outletFilter = getOutletFilter(req);

    try {
        const orders = await prisma.order.findMany({
            where: { ...outletFilter, status: { notIn: ['Cancelled', 'Rejected'] }, is_delivered: true },
            include: {
                installment_ledger: true,
                outlet: { select: { id: true, name: true } },
                recovery_officer: { select: { id: true, full_name: true } },
            },
        });

        const today = new Date();
        const buckets = emptyBuckets();
        const outletMap = {};
        const officerMap = {};
        const items = [];

        for (const order of orders) {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];

            for (const row of rows) {
                if (row.status === 'paid') continue;
                if (!row.dueDate) continue;

                const dueDate = new Date(row.dueDate);
                const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
                const outstanding = parseFloat(row.remainingAmount ?? ((row.amount || 0) - (row.paidAmount || 0)));
                if (!(outstanding > 0)) continue;

                const bucket = bucketFor(daysOverdue);
                buckets[bucket] += outstanding;

                const outletKey = order.outlet_id ?? 'unassigned';
                if (!outletMap[outletKey]) outletMap[outletKey] = { outlet_id: order.outlet_id, outlet_name: order.outlet?.name || 'Unassigned', ...emptyBuckets(), total: 0 };
                outletMap[outletKey][bucket] += outstanding;
                outletMap[outletKey].total += outstanding;

                const officerKey = order.recovery_officer_id ?? 'unassigned';
                if (!officerMap[officerKey]) officerMap[officerKey] = { officer_id: order.recovery_officer_id, officer_name: order.recovery_officer?.full_name || 'Unassigned', ...emptyBuckets(), total: 0 };
                officerMap[officerKey][bucket] += outstanding;
                officerMap[officerKey].total += outstanding;

                items.push({
                    order_id: order.id,
                    order_ref: order.order_ref,
                    customer_name: order.customer_name,
                    outlet_name: order.outlet?.name || 'Unassigned',
                    officer_name: order.recovery_officer?.full_name || 'Unassigned',
                    month: row.month,
                    dueDate: row.dueDate,
                    daysOverdue,
                    bucket,
                    outstanding,
                });
            }
        }

        items.sort((a, b) => b.daysOverdue - a.daysOverdue);

        res.json({
            success: true,
            data: {
                buckets,
                total: AGING_BUCKETS.reduce((acc, b) => acc + buckets[b], 0),
                outletWise: Object.values(outletMap).sort((a, b) => b.total - a.total),
                officerWise: Object.values(officerMap).sort((a, b) => b.total - a.total),
                items,
            },
        });
    } catch (error) {
        console.error('getInstallmentAging error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const ONE_BILL_SUCCESS = ['paid'];
const SMARTPAY_SUCCESS = ['paid', 'success', 'processed', 'already_paid'];

/**
 * getOnlinePaymentsOverview
 * Read-only reconciliation view over the raw 1Bill (TpsPaymentLog) and
 * SmartPay (SmartPayPaymentLog) webhook logs — no writes, since real
 * payment processing lives in tpsController/smartPayController and isn't
 * touched here. "Matched" = the webhook resulted in a recorded payment
 * (status indicates success); everything else is failed/pending/duplicate.
 */
const getOnlinePaymentsOverview = async (req, res) => {
    const { range = 'Month', startDate, endDate } = req.query;
    const dateFilter = getDateRangeFilter(range, startDate, endDate);
    const whereDate = dateFilter ? { created_at: { gte: dateFilter.gte, lt: dateFilter.lt } } : {};

    try {
        const [oneBillLogs, smartPayLogs] = await Promise.all([
            prisma.tpsPaymentLog.findMany({ where: whereDate, orderBy: { created_at: 'desc' } }),
            prisma.smartPayPaymentLog.findMany({ where: whereDate, orderBy: { created_at: 'desc' } }),
        ]);

        const summarize = (logs, successStatuses) => {
            let total = 0, matched = 0, failed = 0, duplicate = 0;
            for (const log of logs) {
                const amount = parseFloat(log.transaction_amount_parsed ?? log.amount ?? 0);
                if (log.is_duplicate) duplicate += 1;
                else if (successStatuses.includes(log.status)) {
                    matched += 1;
                    total += amount;
                } else {
                    failed += 1;
                }
            }
            return { total, count: logs.length, matched, failed, duplicate };
        };

        const oneBill = summarize(oneBillLogs, ONE_BILL_SUCCESS);
        const smartPay = summarize(smartPayLogs, SMARTPAY_SUCCESS);

        const recent = [
            ...oneBillLogs.slice(0, 100).map((l) => ({
                channel: '1Bill', consumer_number: l.consumer_number, amount: parseFloat(l.transaction_amount_parsed),
                status: l.is_duplicate ? 'duplicate' : (l.status === 'paid' ? 'matched' : 'failed'),
                reference: l.tran_auth_id, created_at: l.created_at,
            })),
            ...smartPayLogs.slice(0, 100).map((l) => ({
                channel: 'SmartPay', consumer_number: l.consumer_number, amount: parseFloat(l.amount),
                status: l.is_duplicate ? 'duplicate' : (SMARTPAY_SUCCESS.includes(l.status) ? 'matched' : 'failed'),
                reference: l.transactionId, created_at: l.created_at,
            })),
        ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 150);

        res.json({
            success: true,
            data: {
                range,
                totalOnline: oneBill.total + smartPay.total,
                channels: { oneBill, smartPay },
                recent,
            },
        });
    } catch (error) {
        console.error('getOnlinePaymentsOverview error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const monthLabel = (key) => {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
};

/**
 * getMonthlyInstallmentAnalytics
 * Expected (due) vs recovered installment totals for each of the last N
 * months, plus recovery % and any manually-set monthly target. No existing
 * endpoint aggregates by calendar month across the whole business.
 */
const getMonthlyInstallmentAnalytics = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const pastMonths = Math.min(parseInt(req.query.months) || 12, 24);
    const futureMonths = Math.min(parseInt(req.query.futureMonths) || 3, 12);

    try {
        const rangeStart = new Date();
        rangeStart.setMonth(rangeStart.getMonth() - (pastMonths - 1));
        rangeStart.setDate(1);
        rangeStart.setHours(0, 0, 0, 0);

        const totalMonths = pastMonths + futureMonths;
        const thisMonthKey = monthKey(new Date());

        const [orders, targets] = await Promise.all([
            prisma.order.findMany({
                where: { ...outletFilter, status: { notIn: ['Cancelled', 'Rejected'] } },
                include: { installment_ledger: true },
            }),
            prisma.monthlyTarget.findMany(),
        ]);

        const targetByMonth = Object.fromEntries(targets.map((t) => [t.month, t.target_amount]));

        const monthMap = {};
        for (let i = 0; i < totalMonths; i++) {
            const d = new Date(rangeStart);
            d.setMonth(d.getMonth() + i);
            const key = monthKey(d);
            monthMap[key] = { month: key, label: monthLabel(key), due: 0, recovered: 0, target: targetByMonth[key] || 0, isProjected: key > thisMonthKey };
        }

        for (const order of orders) {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            for (const row of rows) {
                const amount = parseFloat(row.amount || row.dueAmount || 0);

                if (row.dueDate) {
                    const key = monthKey(new Date(row.dueDate));
                    if (monthMap[key]) monthMap[key].due += amount;
                }
                if (row.status === 'paid' && row.paid_at) {
                    const key = monthKey(new Date(row.paid_at));
                    if (monthMap[key]) monthMap[key].recovered += amount;
                }
            }
        }

        const series = Object.values(monthMap).map((m) => ({ ...m, recoveryPercentage: pct(m.recovered, m.due) }));

        res.json({ success: true, data: { months: series } });
    } catch (error) {
        console.error('getMonthlyInstallmentAnalytics error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * setMonthlyTarget
 * Upserts a recovery target for a given "YYYY-MM" month.
 */
const setMonthlyTarget = async (req, res) => {
    try {
        const { month, target_amount } = req.body;
        if (!month || !/^\d{4}-\d{2}$/.test(month) || target_amount === undefined) {
            return res.status(400).json({ success: false, message: 'month (YYYY-MM) and target_amount are required.' });
        }

        const target = await prisma.monthlyTarget.upsert({
            where: { month },
            update: { target_amount: parseFloat(target_amount), created_by_id: req.user.id },
            create: { month, target_amount: parseFloat(target_amount), created_by_id: req.user.id },
        });

        res.json({ success: true, data: target });
    } catch (error) {
        console.error('setMonthlyTarget error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const classifyChannel = (paymentMethod) => {
    const m = (paymentMethod || '').toLowerCase();
    if (m.includes('smartpay') || m.includes('1link') || m.includes('tps') || m.includes('online')) return 'online';
    if (m.includes('cash')) return 'cash';
    return 'other';
};

/**
 * getInstallmentFlowAnalytics
 * Collection trend + online vs cash split + a day-of-week x outlet
 * recovery heatmap, all from the same paid-ledger-row scan used
 * elsewhere (getInstallmentRecoveriesReport, getRecoveryAnalytics).
 */
const getInstallmentFlowAnalytics = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { range = 'Month', startDate, endDate } = req.query;
    const dateFilter = getDateRangeFilter(range, startDate, endDate);

    try {
        const orders = await prisma.order.findMany({
            where: { ...outletFilter, status: { notIn: ['Cancelled', 'Rejected'] } },
            include: { installment_ledger: true, outlet: { select: { id: true, name: true } } },
        });

        const trendByDate = {};
        let cashTotal = 0;
        let onlineTotal = 0;
        let otherTotal = 0;
        const heatmap = {}; // outlet_name -> [0..6] day-of-week totals

        for (const order of orders) {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            const outletName = order.outlet?.name || 'Unassigned';

            for (const row of rows) {
                if (row.status !== 'paid' || !row.paid_at) continue;
                const paidDate = new Date(row.paid_at);
                if (dateFilter && (paidDate < dateFilter.gte || paidDate >= dateFilter.lt)) continue;

                const amount = parseFloat(row.amount || row.dueAmount || 0);
                const dateKey = paidDate.toISOString().slice(0, 10);
                const channel = classifyChannel(row.payment_method);

                if (!trendByDate[dateKey]) trendByDate[dateKey] = { date: dateKey, cash: 0, online: 0, other: 0, total: 0 };
                trendByDate[dateKey][channel] += amount;
                trendByDate[dateKey].total += amount;

                if (channel === 'cash') cashTotal += amount;
                else if (channel === 'online') onlineTotal += amount;
                else otherTotal += amount;

                if (!heatmap[outletName]) heatmap[outletName] = [0, 0, 0, 0, 0, 0, 0];
                heatmap[outletName][paidDate.getDay()] += amount;
            }
        }

        const trend = Object.values(trendByDate).sort((a, b) => (a.date > b.date ? 1 : -1));

        res.json({
            success: true,
            data: {
                range,
                trend,
                channelSplit: { cash: cashTotal, online: onlineTotal, other: otherTotal, total: cashTotal + onlineTotal + otherTotal },
                heatmap: Object.entries(heatmap).map(([outlet_name, days]) => ({ outlet_name, days })),
            },
        });
    } catch (error) {
        console.error('getInstallmentFlowAnalytics error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getChannelWiseRecovery
 * Recovery percentage split by payment channel — how much of what's due
 * is being recovered via cash vs online vs other, for the recovery
 * percentage analytics module.
 */
const getChannelWiseRecovery = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { range = 'Month', startDate, endDate } = req.query;
    const dateFilter = getDateRangeFilter(range, startDate, endDate);

    try {
        const orders = await prisma.order.findMany({
            where: { ...outletFilter, status: { notIn: ['Cancelled', 'Rejected'] } },
            include: { installment_ledger: true },
        });

        const channels = { cash: 0, online: 0, other: 0 };
        let totalDue = 0;

        for (const order of orders) {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            for (const row of rows) {
                const amount = parseFloat(row.amount || row.dueAmount || 0);

                if (row.dueDate) {
                    const dueDate = new Date(row.dueDate);
                    if (!dateFilter || (dueDate >= dateFilter.gte && dueDate < dateFilter.lt)) totalDue += amount;
                }
                if (row.status === 'paid' && row.paid_at) {
                    const paidDate = new Date(row.paid_at);
                    if (!dateFilter || (paidDate >= dateFilter.gte && paidDate < dateFilter.lt)) {
                        channels[classifyChannel(row.payment_method)] += amount;
                    }
                }
            }
        }

        const totalRecovered = channels.cash + channels.online + channels.other;

        res.json({
            success: true,
            data: {
                range, totalDue, totalRecovered,
                overallRecoveryPercentage: pct(totalRecovered, totalDue),
                byChannel: [
                    { channel: 'Cash', amount: channels.cash, percentageOfDue: pct(channels.cash, totalDue) },
                    { channel: 'Online', amount: channels.online, percentageOfDue: pct(channels.online, totalDue) },
                    { channel: 'Other', amount: channels.other, percentageOfDue: pct(channels.other, totalDue) },
                ],
            },
        });
    } catch (error) {
        console.error('getChannelWiseRecovery error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getGlobalAlerts
 * Cross-cutting alert feed for the Accounts Dashboard's "Global Alerts &
 * Notifications" widget — lightweight, dashboard-sized cousin of
 * accountsAuditController.getFraudAlerts, combining cash/vendor/aging/
 * bank signals rather than only fraud-specific ones.
 */
const getGlobalAlerts = async (req, res) => {
    try {
        const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
        const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        const [stalePendingCash, vendorDueSoon, lowBankAccounts, blacklistedToday] = await Promise.all([
            prisma.cashInHand.count({ where: { status: 'pending', created_at: { lte: seventyTwoHoursAgo } } }),
            prisma.vendorPurchase.count({ where: { balance: { gt: 0 }, due_date: { lte: sevenDaysFromNow } } }),
            prisma.bankAccount.findMany({ where: { is_active: true, current_balance: { lt: 10000 } }, select: { bank_name: true, account_number: true, current_balance: true } }),
            prisma.blacklistAction.count({ where: { action: 'blacklist', created_at: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }),
        ]);

        const alerts = [];
        if (stalePendingCash > 0) alerts.push({ severity: 'warning', title: 'Cash pending submission', message: `${stalePendingCash} cash-in-hand entr${stalePendingCash === 1 ? 'y has' : 'ies have'} been unsubmitted for over 72 hours.`, link: '/accounts/cash-in-hand' });
        if (vendorDueSoon > 0) alerts.push({ severity: 'warning', title: 'Vendor payments due soon', message: `${vendorDueSoon} vendor purchase(s) due within 7 days.`, link: '/accounts/vendors' });
        for (const acc of lowBankAccounts) alerts.push({ severity: 'serious', title: 'Low bank balance', message: `${acc.bank_name} (${acc.account_number}) balance is PKR ${acc.current_balance.toLocaleString()}.`, link: '/accounts/bank-accounts' });
        if (blacklistedToday > 0) alerts.push({ severity: 'good', title: 'Blacklist activity today', message: `${blacklistedToday} customer(s) blacklisted today.`, link: '/accounts/blacklist' });

        res.json({ success: true, data: { count: alerts.length, alerts } });
    } catch (error) {
        console.error('getGlobalAlerts error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getInstallmentReceivingOverview
 * Consolidated tracking view for "Installment Receiving" — due
 * installments company-wide, advance-vs-partial-vs-full payment mix, and
 * a recent-collections feed. Actual payment collection stays in the
 * existing officer/outlet OTP-gated flows (ledgerController,
 * recoveryController) — this is the oversight/tracking layer on top.
 */
const getInstallmentReceivingOverview = async (req, res) => {
    const outletFilter = getOutletFilter(req);

    try {
        const orders = await prisma.order.findMany({
            where: { ...outletFilter, status: { notIn: ['Cancelled', 'Rejected'] }, is_delivered: true },
            include: { installment_ledger: true, outlet: { select: { name: true } } },
        });

        const today = new Date();
        const dueList = [];
        let advancePending = 0, partialCount = 0, fullyPaidCount = 0;
        let cashCollected = 0, onlineCollected = 0;

        for (const order of orders) {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            let hasPartial = false;
            let allPaid = rows.length > 0;

            for (const row of rows) {
                if (row.month === 0 && row.status !== 'paid') advancePending += parseFloat(row.amount || 0);
                if (row.status !== 'paid') allPaid = false;
                if (row.status === 'partial') hasPartial = true;

                if (row.status === 'paid' && row.paid_at) {
                    const amount = parseFloat(row.amount || 0);
                    const method = (row.payment_method || '').toLowerCase();
                    if (method.includes('smartpay') || method.includes('1link') || method.includes('tps')) onlineCollected += amount;
                    else cashCollected += amount;
                }

                if (row.status !== 'paid' && row.dueDate && new Date(row.dueDate) <= today) {
                    dueList.push({
                        order_id: order.id, order_ref: order.order_ref, customer_name: order.customer_name,
                        outlet_name: order.outlet?.name, month: row.month, dueDate: row.dueDate, amount: row.amount,
                    });
                }
            }

            if (allPaid) fullyPaidCount += 1;
            else if (hasPartial) partialCount += 1;
        }

        dueList.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

        res.json({
            success: true,
            data: {
                dueCount: dueList.length,
                due: dueList.slice(0, 200),
                advancePending,
                mix: { fullyPaidCount, partialCount, otherCount: orders.length - fullyPaidCount - partialCount },
                collections: { cash: cashCollected, online: onlineCollected },
            },
        });
    } catch (error) {
        console.error('getInstallmentReceivingOverview error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getCashInHandOverview,
    getGlobalExpenseSummary,
    getGlobalVendorPayables,
    getRecoveryAnalytics,
    getDashboardSummary,
    getInstallmentAging,
    getOnlinePaymentsOverview,
    getMonthlyInstallmentAnalytics,
    setMonthlyTarget,
    getInstallmentFlowAnalytics,
    getChannelWiseRecovery,
    getGlobalAlerts,
    getInstallmentReceivingOverview,
};
