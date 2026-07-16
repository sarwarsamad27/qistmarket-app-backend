const prisma = require('../../lib/prisma');
const { getOutletFilter } = require('../utils/outletFilter');

/**
 * getCashReports
 * Daily/Weekly/Monthly cash reports built on the existing CashRegister
 * daybook rows (one row per outlet per date already maintained by
 * cashRegisterUtils.updateCashRegister across expense/vendor/installment flows).
 */
const getCashReports = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { period = 'daily', startDate, endDate } = req.query;

    try {
        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        } else if (!startDate) {
            // Default window: last 30 days for daily, 12 weeks for weekly, 12 months for monthly
            const days = period === 'monthly' ? 365 : period === 'weekly' ? 84 : 30;
            dateFilter.gte = new Date(Date.now() - days * 86400000);
        }

        const registers = await prisma.cashRegister.findMany({
            where: { ...outletFilter, ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}) },
            include: { outlet: { select: { id: true, name: true } } },
            orderBy: { date: 'desc' },
        });

        const bucketKey = (date) => {
            const d = new Date(date);
            if (period === 'monthly') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            if (period === 'weekly') {
                const firstDay = new Date(d);
                firstDay.setDate(d.getDate() - d.getDay());
                return firstDay.toISOString().slice(0, 10);
            }
            return d.toISOString().slice(0, 10);
        };

        const buckets = {};
        for (const r of registers) {
            const key = bucketKey(r.date);
            if (!buckets[key]) {
                buckets[key] = {
                    period: key, opening_cash: 0, down_payments: 0, installments_received: 0,
                    cash_from_recovery: 0, cash_from_delivery: 0, expenses: 0, vendor_payments: 0, closing_cash: 0, count: 0,
                };
            }
            const b = buckets[key];
            b.down_payments += r.down_payments;
            b.installments_received += r.installments_received;
            b.cash_from_recovery += r.cash_from_recovery;
            b.cash_from_delivery += r.cash_from_delivery;
            b.expenses += r.expenses;
            b.vendor_payments += r.vendor_payments;
            b.closing_cash += r.closing_cash;
            b.count += 1;
        }

        const series = Object.values(buckets).sort((a, b) => (a.period < b.period ? 1 : -1));

        res.json({
            success: true,
            data: {
                period,
                series,
                outletWise: registers.reduce((acc, r) => {
                    const key = r.outlet_id;
                    if (!acc[key]) acc[key] = { outlet_id: r.outlet_id, outlet_name: r.outlet?.name || 'Unassigned', closing_cash: 0 };
                    acc[key].closing_cash += r.closing_cash;
                    return acc;
                }, {}),
            },
        });
    } catch (error) {
        console.error('getCashReports error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getCashSubmissionHistory
 * Global (or single-outlet) history of cash submissions, extending the
 * outlet-scoped-only pattern from outletController.getOutletCashHistory.
 */
const getCashSubmissionHistory = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { startDate, endDate, page = 1, limit = 25 } = req.query;

    try {
        const where = { status: 'paid', ...outletFilter };
        if (startDate || endDate) {
            where.submission_date = {};
            if (startDate) where.submission_date.gte = new Date(startDate);
            if (endDate) where.submission_date.lte = new Date(endDate);
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [history, total] = await Promise.all([
            prisma.cashSubmissionHistory.findMany({
                where,
                include: {
                    cash_in_hand: {
                        include: {
                            officer: { select: { full_name: true, username: true } },
                            outlet: { select: { name: true } },
                        },
                    },
                },
                orderBy: { submission_date: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.cashSubmissionHistory.count({ where }),
        ]);

        res.json({
            success: true,
            data: history.map((h) => ({
                id: h.id,
                amount_submitted: h.amount_submitted,
                submission_date: h.submission_date,
                submission_ref: h.submission_ref,
                officer: h.cash_in_hand?.officer?.full_name || 'Unknown',
                outlet: h.cash_in_hand?.outlet?.name || 'Unassigned',
            })),
            pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error('getCashSubmissionHistory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getCashLimits
 * Configured daily cash limits per outlet/officer, joined with today's
 * actual pending cash so the UI can flag anyone over their limit.
 */
const getCashLimits = async (req, res) => {
    try {
        const limits = await prisma.cashLimit.findMany({ orderBy: { created_at: 'desc' } });

        const outletIds = limits.filter((l) => l.scope_type === 'outlet').map((l) => l.scope_id);
        const officerIds = limits.filter((l) => l.scope_type === 'officer').map((l) => l.scope_id);

        const [outlets, officers, cashByOutlet, cashByOfficer] = await Promise.all([
            outletIds.length ? prisma.outlet.findMany({ where: { id: { in: outletIds } }, select: { id: true, name: true } }) : [],
            officerIds.length ? prisma.user.findMany({ where: { id: { in: officerIds } }, select: { id: true, full_name: true } }) : [],
            outletIds.length ? prisma.cashInHand.groupBy({ by: ['outlet_id'], where: { outlet_id: { in: outletIds }, status: 'pending' }, _sum: { amount: true, submitted_amount: true } }) : [],
            officerIds.length ? prisma.cashInHand.groupBy({ by: ['officer_id'], where: { officer_id: { in: officerIds }, status: 'pending' }, _sum: { amount: true, submitted_amount: true } }) : [],
        ]);

        const outletNameById = Object.fromEntries(outlets.map((o) => [o.id, o.name]));
        const officerNameById = Object.fromEntries(officers.map((o) => [o.id, o.full_name]));
        const outletPending = Object.fromEntries(cashByOutlet.map((c) => [c.outlet_id, (c._sum.amount || 0) - (c._sum.submitted_amount || 0)]));
        const officerPending = Object.fromEntries(cashByOfficer.map((c) => [c.officer_id, (c._sum.amount || 0) - (c._sum.submitted_amount || 0)]));

        const data = limits.map((l) => {
            const current = l.scope_type === 'outlet' ? (outletPending[l.scope_id] || 0) : (officerPending[l.scope_id] || 0);
            const name = l.scope_type === 'outlet' ? (outletNameById[l.scope_id] || 'Unknown outlet') : (officerNameById[l.scope_id] || 'Unknown officer');
            return { id: l.id, scope_type: l.scope_type, scope_id: l.scope_id, name, daily_limit: l.daily_limit, current_pending: current, is_over_limit: current > l.daily_limit };
        });

        res.json({ success: true, data });
    } catch (error) {
        console.error('getCashLimits error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const setCashLimit = async (req, res) => {
    try {
        const { scope_type, scope_id, daily_limit } = req.body;
        if (!['outlet', 'officer'].includes(scope_type) || !scope_id || daily_limit === undefined) {
            return res.status(400).json({ success: false, message: 'scope_type (outlet/officer), scope_id, and daily_limit are required.' });
        }

        const limit = await prisma.cashLimit.upsert({
            where: { scope_type_scope_id: { scope_type, scope_id: parseInt(scope_id) } },
            update: { daily_limit: parseFloat(daily_limit), created_by_id: req.user.id },
            create: { scope_type, scope_id: parseInt(scope_id), daily_limit: parseFloat(daily_limit), created_by_id: req.user.id },
        });

        res.json({ success: true, data: limit });
    } catch (error) {
        console.error('setCashLimit error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const deleteCashLimit = async (req, res) => {
    try {
        await prisma.cashLimit.delete({ where: { id: parseInt(req.params.id) } });
        res.json({ success: true, message: 'Cash limit removed.' });
    } catch (error) {
        console.error('deleteCashLimit error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getCashReports,
    getCashSubmissionHistory,
    getCashLimits,
    setCashLimit,
    deleteCashLimit,
};
