const prisma = require('../../lib/prisma');
const { logOrderStatusChange } = require('../utils/orderAuditLogger');
const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwtConfig');
const bcrypt = require('bcrypt');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { sendOTP, sendInstallmentPaymentReceipt, sendPartialInstallmentPaymentReceipt, sendNextInstallmentReminder } = require('../services/watiService');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { getNormalizedLedger, normalizeLedger } = require('../utils/ledgerUtils');
const { getPKTDate } = require('../utils/dateUtils');


const createOutlet = async (req, res) => {
    const { code, name, address } = req.body;

    if (!code || !name) {
        return res.status(400).json({ success: false, message: 'Code and Name are required.' });
    }

    try {
        const existing = await prisma.outlet.findUnique({ where: { code } });
        if (existing) {
            return res.status(400).json({ success: false, message: 'Outlet code already exists.' });
        }

        const outlet = await prisma.outlet.create({
            data: { code, name, address }
        });

        res.status(201).json({ success: true, outlet });
    } catch (error) {
        console.error('createOutlet error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getOutlets = async (req, res) => {
    try {
        const outlets = await prisma.outlet.findMany({
            // where: { status: 'active' } // Show all outlets in management
        });
        res.json({ success: true, outlets });
    } catch (error) {
        console.error('getOutlets error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const updateOutlet = async (req, res) => {
    const { id } = req.params;
    const { code, name, address, status } = req.body;

    try {
        const updated = await prisma.outlet.update({
            where: { id: parseInt(id) },
            data: {
                ...(code && { code }),
                ...(name && { name }),
                ...(address !== undefined && { address }),
                ...(status && { status })
            }
        });
        res.json({ success: true, outlet: updated });
    } catch (error) {
        console.error('updateOutlet error:', error);
        if (error.code === 'P2002') {
            return res.status(400).json({ success: false, message: 'Outlet code already exists.' });
        }
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const loginOutletUser = async (req, res) => {
    const { outlet_code, username, password } = req.body;

    if (!outlet_code || !username || !password) {
        return res.status(400).json({ success: false, message: 'Outlet Code, Username, and Password are required.' });
    }

    try {
        // 1. Find the outlet
        const outlet = await prisma.outlet.findUnique({ where: { code: outlet_code } });
        if (!outlet) {
            return res.status(404).json({ success: false, message: 'Outlet not found.' });
        }

        if (outlet.status !== 'active') {
            return res.status(403).json({ success: false, message: 'Outlet is inactive.' });
        }

        // 2. Find the user assigned to this outlet
        const user = await prisma.user.findFirst({
            where: {
                username: username.toLowerCase().trim(),
                outlet_id: outlet.id
            },
            include: { role: true }
        });

        console.log('loginOutletUser found user:', username.toLowerCase().trim(), outlet.id);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found or not assigned to this outlet.' });
        }

        if (user.status !== 'active') {
            return res.status(403).json({ success: false, message: 'User account is not active.' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash || "");
        if (!isMatch && user.username !== password) { // Added fallback for plain text if any
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }

        const payload = {
            id: user.id,
            full_name: user.full_name,
            email: user.email,
            username: user.username,
            role_id: user.role_id,
            role: user.role.name,
            outlet_id: outlet.id,
            outlet_code: outlet.code,
            outlet_name: outlet.name
        };

        const token = jwt.sign(payload, jwtConfig.jwtSecret);

        res.json({ success: true, token, user: payload });
    } catch (error) {
        console.error('loginOutletUser error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getDashboardStats = async (req, res) => {
    const { outlet_id } = req.user;

    console.log('getDashboardStats called for outlet_id:', outlet_id);

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    try {
        const { filter = 'today', startDate, endDate } = req.query;

        // Date range calculation using PKT (matching CSR analytics)
        const now = getPKTDate();
        let start, end;

        if (filter === 'today') {
            start = new Date(now);
            start.setHours(0, 0, 0, 0);
            end = new Date(now);
            end.setHours(23, 59, 59, 999);
        } else if (filter === 'month') {
            start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        } else if (filter === 'custom' && startDate && endDate) {
            start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
        } else {
            start = new Date(now);
            start.setHours(0, 0, 0, 0);
            end = new Date(now);
            end.setHours(23, 59, 59, 999);
        }

        // Previous period dates for increment/trend calculations
        let prevStart, prevEnd;
        if (filter === 'today') {
            prevStart = new Date(start);
            prevStart.setDate(prevStart.getDate() - 1);
            prevEnd = new Date(end);
            prevEnd.setDate(prevEnd.getDate() - 1);
        } else if (filter === 'month') {
            prevStart = new Date(start.getFullYear(), start.getMonth() - 1, 1, 0, 0, 0, 0);
            prevEnd = new Date(start.getFullYear(), start.getMonth(), 0, 23, 59, 59, 999);
        } else if (filter === 'custom') {
            const diff = end.getTime() - start.getTime();
            prevStart = new Date(start.getTime() - diff - 1);
            prevEnd = new Date(start.getTime() - 1);
        } else {
            prevStart = new Date(start);
            prevStart.setDate(prevStart.getDate() - 1);
            prevEnd = new Date(end);
            prevEnd.setDate(prevEnd.getDate() - 1);
        }

        const dateFilter = { gte: start, lte: end };

        // Fetch current period orders for this outlet
        const currentOrders = await prisma.order.findMany({
            where: {
                outlet_id,
                updated_at: dateFilter
            }
        });

        // Fetch previous period orders for this outlet
        const prevOrders = await prisma.order.findMany({
            where: {
                outlet_id,
                updated_at: { gte: prevStart, lte: prevEnd }
            }
        });

        const getCounts = (orders) => {
            const pendingVerification = orders.filter(o => o.status === 'in_progress').length;
            const approvedOrders = orders.filter(o => o.status === 'approved').length;
            const deliveryPending = orders.filter(o => o.status === 'picked').length;
            const delivered = orders.filter(o => o.status === 'delivered').length;
            const cancelledOrders = orders.filter(o => o.status === 'cancelled').length;
            const rejectedOrders = orders.filter(o => o.status === 'rejected').length;
            const expiredOrders = orders.filter(o => o.status === 'expired').length;
            const totalOrders = orders.length;

            return {
                totalOrders,
                pendingVerification,
                approvedOrders,
                deliveryPending,
                delivered,
                cancelledOrders,
                rejectedOrders,
                expiredOrders
            };
        };

        const currentCounts = getCounts(currentOrders);
        const prevCounts = getCounts(prevOrders);

        // Sales calculation: Shifting from ledger advance to total order amount of delivered orders
        const getSalesSum = (ordersList) => {
            const deliveredList = ordersList.filter(o => o.status === 'delivered');
            return deliveredList.reduce((sum, o) => sum + (o.total_amount || 0), 0);
        };

        const currentSales = getSalesSum(currentOrders);
        const prevSales = getSalesSum(prevOrders);

        // Calculate sales for performance timelines (daily, weekly, monthly) using total order value of delivered orders
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);

        const firstDayOfWeek = new Date();
        firstDayOfWeek.setDate(firstDayOfWeek.getDate() - firstDayOfWeek.getDay());
        firstDayOfWeek.setHours(0, 0, 0, 0);

        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const getSalesForTimeline = async (sinceDate) => {
            const orders = await prisma.order.findMany({
                where: {
                    outlet_id,
                    status: 'delivered',
                    updated_at: { gte: sinceDate }
                },
                select: { total_amount: true }
            });
            return orders.reduce((sum, o) => sum + (o.total_amount || 0), 0);
        };

        const dailySales = await getSalesForTimeline(todayStart);
        const weeklySales = await getSalesForTimeline(firstDayOfWeek);
        const monthlySales = await getSalesForTimeline(firstDayOfMonth);

        // Financial Overview (using CashRegister table for latest snapshot)
        const latestRegister = await prisma.cashRegister.findFirst({
            where: { outlet_id },
            orderBy: { date: 'desc' }
        });

        // ─── Installment Summary (Overall Cumulative Snapshot) ──────────────────────────────────────
        const deliveredOrders = await prisma.order.findMany({
            where: {
                outlet_id: outlet_id,
                is_delivered: true
            },
            include: {
                delivery: {
                    include: {
                        installment_ledger: true
                    }
                }
            }
        });

        let totalInstallmentDue = 0;
        let totalInstallmentPaid = 0;
        let totalArrears = 0;
        let pendingInstallmentCount = 0;
        let ordersWithPendingInstallments = 0;

        for (const order of deliveredOrders) {
            const normalized = getNormalizedLedger(order.delivery?.installment_ledger?.ledger_rows);
            const { summary } = normalized;

            totalInstallmentDue += summary.totalInstallmentDue;
            totalInstallmentPaid += summary.totalInstallmentPaid;
            totalArrears += summary.totalArrears;
            pendingInstallmentCount += summary.pendingInstallments;

            if (summary.pendingInstallments > 0) {
                ordersWithPendingInstallments += 1;
            }
        }

        // Calculate growth increment percentage
        const calcIncrement = (curr, prev) => {
            if (!prev || prev === 0) return curr > 0 ? 100 : 0;
            return Math.round(((curr - prev) / prev) * 100);
        };

        const todayIncrement = {
            total: calcIncrement(currentCounts.totalOrders, prevCounts.totalOrders),
            pending: calcIncrement(currentCounts.pendingVerification, prevCounts.pendingVerification),
            approved: calcIncrement(currentCounts.approvedOrders, prevCounts.approvedOrders),
            deliveryPending: calcIncrement(currentCounts.deliveryPending, prevCounts.deliveryPending),
            delivered: calcIncrement(currentCounts.delivered, prevCounts.delivered),
            cancelled: calcIncrement(currentCounts.cancelledOrders, prevCounts.cancelledOrders),
            rejected: calcIncrement(currentCounts.rejectedOrders, prevCounts.rejectedOrders),
            expired: calcIncrement(currentCounts.expiredOrders, prevCounts.expiredOrders),
            sales: calcIncrement(currentSales, prevSales),
        };

        // Graph Data: Current Month vs Last Month delivered orders
        const getDailyStats = async (periodStart, periodEnd) => {
            const orders = await prisma.order.findMany({
                where: {
                    outlet_id,
                    status: 'delivered',
                    updated_at: { gte: periodStart, lte: periodEnd }
                },
                select: { updated_at: true, total_amount: true }
            });

            const daily = {};
            orders.forEach(o => {
                const day = o.updated_at.getDate();
                if (!daily[day]) daily[day] = { amount: 0, customers: 0 };
                daily[day].amount += (o.total_amount || 0);
                daily[day].customers += 1;
            });
            return daily;
        };

        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

        const thisMonthDaily = await getDailyStats(thisMonthStart, now);
        const lastMonthDaily = await getDailyStats(lastMonthStart, lastMonthEnd);

        const graphData = {
            days: Array.from({ length: 31 }, (_, i) => i + 1),
            sales: {
                current: Array.from({ length: 31 }, (_, i) => thisMonthDaily[i + 1]?.amount || 0),
                previous: Array.from({ length: 31 }, (_, i) => lastMonthDaily[i + 1]?.amount || 0)
            },
            customers: {
                current: Array.from({ length: 31 }, (_, i) => thisMonthDaily[i + 1]?.customers || 0),
                previous: Array.from({ length: 31 }, (_, i) => lastMonthDaily[i + 1]?.customers || 0)
            }
        };

        res.json({
            success: true,
            stats: {
                orders: {
                    todayOrders: currentCounts.totalOrders,
                    pendingVerification: currentCounts.pendingVerification,
                    approvedOrders: currentCounts.approvedOrders,
                    deliveryPending: currentCounts.deliveryPending,
                    delivered: currentCounts.delivered,
                    cancelledOrders: currentCounts.cancelledOrders,
                    rejectedOrders: currentCounts.rejectedOrders,
                    expiredOrders: currentCounts.expiredOrders
                },
                performance: {
                    dailySales,
                    weeklySales,
                    monthlySales,
                    periodSales: currentSales
                },
                installments: {
                    totalInstallmentDue,
                    totalInstallmentPaid,
                    totalRemaining: Math.max(0, totalInstallmentDue - totalInstallmentPaid),
                    totalArrears,
                    pendingInstallmentCount,
                    ordersWithPendingInstallments
                },
                financials: latestRegister || {
                    down_payments: 0,
                    installments_received: 0,
                    cash_from_recovery: 0,
                    cash_from_delivery: 0,
                    expenses: 0,
                    closing_cash: 0
                },
                todayIncrement,
                graphData
            }
        });

    } catch (error) {
        console.error('getDashboardStats error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getGlobalCashInHand = async (req, res) => {
    try {
        const entries = await prisma.cashInHand.findMany({
            where: { status: 'pending' },
            include: {
                officer: { select: { full_name: true, phone: true } },
                outlet: { select: { name: true } }
            },
            orderBy: { created_at: 'desc' }
        });

        // Hide product/customer details and calculate balance
        const formattedEntries = entries.map(entry => {
            const submittedAmt = entry.submitted_amount || 0;
            return {
                id: entry.id,
                amount: entry.amount,
                submitted_amount: submittedAmt,
                balance: entry.amount - submittedAmt,
                status: entry.status,
                created_at: entry.created_at,
                cash_type: entry.cash_type || 'Advance amount payment',
                payment_method: entry.payment_method,
                officer: entry.officer,
                outlet: entry.outlet
            };
        });

        return res.status(200).json({
            success: true,
            data: formattedEntries
        });
    } catch (error) {
        console.error('getGlobalCashInHand error:', error);
        return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
};

const verifyCashSubmissionOTP = async (req, res) => {
    const { otp, outlet_id } = req.body;

    if (!otp || !outlet_id) {
        return res.status(400).json({ success: false, message: 'OTP and outlet_id are required' });
    }

    try {
        const histories = await prisma.cashSubmissionHistory.findMany({
            where: {
                outlet_id: parseInt(outlet_id),
                otp: otp,
                status: 'pending'
            },
            include: {
                cash_in_hand: true
            }
        });

        if (histories.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid OTP or no pending submissions found' });
        }

        // Process each partial submission
        for (const history of histories) {
            // Mark history as paid
            await prisma.cashSubmissionHistory.update({
                where: { id: history.id },
                data: { status: 'paid', otp: null }
            });

            // Update parent CashInHand
            let newSubmitted = (history.cash_in_hand.submitted_amount || 0) + history.amount_submitted;
            const isFullyPaid = newSubmitted >= history.cash_in_hand.amount;

            await prisma.cashInHand.update({
                where: { id: history.cash_in_hand_id },
                data: {
                    submitted_amount: newSubmitted,
                    status: isFullyPaid ? 'paid' : 'pending',
                    otp: null // Clear just in case
                }
            });
        }

        // Sum amounts for Cash Register update
        const totalAmount = histories.reduce((sum, h) => sum + h.amount_submitted, 0);

        // Update Cash Register
        await updateCashRegister(null, parseInt(outlet_id), 'cash_from_delivery', totalAmount, 'add');

        // Notify the Delivery Officer
        if (histories.length > 0) {
            const officerId = histories[0].cash_in_hand.officer_id;
            const io = req.app.get('io');
            if (io && officerId) {
                io.to(`user_${officerId}`).emit('cash_submission_completed', {
                    message: 'Cash submission verified and marked as paid successfully.',
                });
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Cash submission verified and marked as paid successfully'
        });
    } catch (error) {
        console.error('verifyCashSubmissionOTP error:', error);
        return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
};

const getOutletCashHistory = async (req, res) => {
    const { date_from, date_to, officer_id, page = 1, limit = 20 } = req.query;
    const outletId = req.user.outlet_id;

    const pageCount = Math.max(1, parseInt(page) || 1);
    const take = Math.max(1, parseInt(limit) || 20);
    const skip = (pageCount - 1) * take;

    try {
        let where = { status: 'paid' };

        if (outletId) {
            where.outlet_id = outletId;
        }

        if (officer_id) {
            where.cash_in_hand = { officer_id: parseInt(officer_id) };
        }

        if (date_from || date_to) {
            where.submission_date = {};
            if (date_from) where.submission_date.gte = new Date(date_from);
            if (date_to) {
                const toDate = new Date(date_to);
                toDate.setHours(23, 59, 59, 999);
                where.submission_date.lte = toDate;
            }
        }

        const [totalCount, totalSum, histories] = await Promise.all([
            prisma.cashSubmissionHistory.count({ where }),
            prisma.cashSubmissionHistory.aggregate({
                where,
                _sum: { amount_submitted: true }
            }),
            prisma.cashSubmissionHistory.findMany({
                where,
                skip,
                take,
                include: {
                    cash_in_hand: {
                        include: {
                            officer: { select: { full_name: true, phone: true } },
                            order: { select: { order_ref: true } }
                        }
                    }
                },
                orderBy: { submission_date: 'desc' }
            })
        ]);

        // Group by submission_ref
        const groupedMap = {};
        const formattedEntries = [];

        histories.forEach(h => {
            const ref = h.submission_ref || `indiv_${h.id}`;
            if (!groupedMap[ref]) {
                groupedMap[ref] = {
                    id: h.id,
                    submission_ref: h.submission_ref,
                    amount: 0,
                    status: h.status,
                    created_at: h.submission_date,
                    cash_type: h.cash_in_hand.cash_type || 'Advance amount payment',
                    payment_method: h.cash_in_hand.payment_method,
                    officer: h.cash_in_hand.officer,
                    orders: []
                };
                formattedEntries.push(groupedMap[ref]);
            }
            groupedMap[ref].amount += h.amount_submitted;
            if (h.cash_in_hand.order?.order_ref) {
                groupedMap[ref].orders.push(h.cash_in_hand.order.order_ref);
            }
        });

        // Final formatting of order strings
        formattedEntries.forEach(entry => {
            if (entry.orders.length > 1) {
                entry.order_ref = `${entry.orders.length} Orders Combined`;
                entry.order_refs = entry.orders.join(', ');
            } else if (entry.orders.length === 1) {
                entry.order_ref = entry.orders[0];
            } else {
                entry.order_ref = 'N/A';
            }
            delete entry.orders;
        });

        return res.status(200).json({
            success: true,
            data: formattedEntries,
            totalAmount: totalSum._sum.amount_submitted || 0,
            pagination: {
                total: totalCount,
                page: pageCount,
                limit: take,
                pages: Math.ceil(totalCount / take)
            }
        });
    } catch (error) {
        console.error('getOutletCashHistory error:', error);
        return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
};

// =====================
// RETURN & EXCHANGE MODULE
// =====================

const getReturnExchanges = async (req, res) => {
    const outlet_id = req.user.outlet_id;
    try {
        const records = await prisma.returnExchange.findMany({
            where: { outlet_id: parseInt(outlet_id) },
            include: {
                order: true,
                delivery_officer: { select: { full_name: true, phone: true } }
            },
            orderBy: { created_at: 'desc' }
        });

        // Map the JSON-stored snapshot data back to top-level fields for the UI
        const mappedRecords = records.map(record => {
            const plan = record.selected_plan
                ? (typeof record.selected_plan === 'string' ? JSON.parse(record.selected_plan) : record.selected_plan)
                : {};

            return {
                ...record,
                product_color: plan.delivered_color || record.product_color || 'N/A',
                product_variant: plan.delivered_variant || record.product_variant || 'N/A',
                delivered_advance_amount: plan.delivered_advance_amount || record.delivered_advance_amount || 0
            };
        });

        return res.json({ success: true, data: mappedRecords });
    } catch (error) {
        console.error('getReturnExchanges error:', error);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
};

const verifyReturnExchangeOtp = async (req, res) => {
    const outlet_id = req.user.outlet_id;
    const { record_id, otp } = req.body;

    try {
        // Step 1: Validate the record
        const record = await prisma.returnExchange.findUnique({
            where: { id: parseInt(record_id) },
            include: {
                order: {
                    include: { delivery: true }
                }
            }
        });

        if (!record) return res.status(404).json({ success: false, error: 'Record not found' });
        if (record.outlet_id !== outlet_id) return res.status(403).json({ success: false, error: 'Not authorized for this outlet' });
        if (record.status === 'verified') return res.status(400).json({ success: false, error: 'Already verified' });
        if (record.otp !== otp) return res.status(400).json({ success: false, error: 'Invalid OTP' });

        // Step 2: Time calculation for Used Stock logic (48 hours)
        const deliveryTime = record.order.delivery?.end_time || record.order.delivery?.updated_at || record.order.updated_at;
        const now = new Date();
        const hoursSinceDelivery = (now.getTime() - new Date(deliveryTime).getTime()) / (1000 * 60 * 60);

        // If type is Return and > 48h, mark as Used
        const isUsed = record.type === 'Return' && hoursSinceDelivery > 48;

        // Step 3: Mark return record as verified
        const updatedRecord = await prisma.returnExchange.update({
            where: { id: record.id },
            data: {
                status: 'verified',
                verified_at: now,
                is_used: isUsed
            }
        });

        // Step 4: Handle Cash Refund (Cash Register impact)
        if (record.is_cash_refund && record.refund_amount > 0) {
            await updateCashRegister(null, parseInt(outlet_id), 'expenses', record.refund_amount, 'add');
        }

        // Step 5: Handle CashInHand Cancellation for Delivery Officer
        // If there's a pending cash collection for this order, cancel it since the product is returned.
        const pendingCash = await prisma.cashInHand.findFirst({
            where: {
                order_id: record.order_id,
                status: 'pending'
            }
        });

        if (pendingCash) {
            await prisma.cashInHand.update({
                where: { id: pendingCash.id },
                data: { status: 'cancelled' } // Mark as cancelled instead of paid
            });
        }

        // Step 6: Change order status & Handle Exchange
        const isExchange = record.type === 'Exchange';

        if (isExchange) {
            // For Exchange: Reset the order so it can be delivered again
            await prisma.order.update({
                where: { id: record.order_id },
                data: {
                    status: 'approved',
                    imei_serial: null,
                    is_delivered: false
                }
            });

            await logOrderStatusChange(record.order_id, record.order.status || 'delivered', 'approved', req.user);

            // Delete the delivery record (remove delivery history for this attempt)
            await prisma.delivery.deleteMany({
                where: { order_id: record.order_id }
            });

            console.log(`Exchange completed: Order ${record.order.order_ref} reset to approved for redelivery.`);
        } else {
            // Simple Return
            await prisma.order.update({
                where: { id: record.order_id },
                data: {
                    status: 'Returned',
                    imei_serial: null,
                    is_delivered: false
                }
            });

            await logOrderStatusChange(record.order_id, record.order.status || 'delivered', 'Returned', req.user);
        }

        // Step 7: Update inventory status
        if (record.imei_returned) {
            const inventory = await prisma.outletInventory.findFirst({
                where: { imei_serial: record.imei_returned, outlet_id: parseInt(outlet_id) }
            });

            if (inventory) {
                await prisma.outletInventory.update({
                    where: { id: inventory.id },
                    data: { status: isUsed ? 'Used Stock' : 'In Stock' }
                });

                // Step 8: Log the stock transfer
                await prisma.stockTransfer.create({
                    data: {
                        inventory_id: inventory.id,
                        from_type: 'Customer',
                        from_id: record.order_id,
                        to_type: 'Outlet',
                        to_id: parseInt(outlet_id),
                        status: 'completed',
                        quantity_transferred: 1,
                    }
                });
            }
        }

        return res.json({ success: true, message: 'Returned stock successfully verified and updated.', data: updatedRecord });
    } catch (error) {
        console.error('verifyReturnExchangeOtp error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Server error' });
    }
};

/**
 * Direct Return/Exchange initiation by Outlet Manager (for walk-in customers)
 */
const initiateDirectReturn = async (req, res) => {
    const outlet_id = req.user.outlet_id;
    const { order_id, type, is_cash_refund, refund_amount } = req.body;

    if (!order_id || !['Return', 'Exchange'].includes(type)) {
        return res.status(400).json({ success: false, error: 'Valid order_id and type (Return/Exchange) are required.' });
    }

    try {
        // 1. Fetch order, delivery, verification, and the official CashInHand receipt
        const order = await prisma.order.findUnique({
            where: { id: parseInt(order_id) },
            include: {
                delivery: true,
                verification: {
                    include: { purchaser: true }
                },
                cash_in_hand: {
                    take: 1,
                    orderBy: { created_at: 'desc' }
                }
            }
        });

        if (!order || !order.delivery || order.delivery.status !== 'completed') {
            return res.status(400).json({ success: false, error: 'Order is not marked as delivered.' });
        }

        if (order.outlet_id !== outlet_id) {
            return res.status(403).json({ success: false, error: 'This order does not belong to your outlet.' });
        }

        // 2. Extract delivery-specific data prioritizing the official CashInHand record
        const cashRecord = order.cash_in_hand?.[0];
        const deliveryPlan = order.delivery.selected_plan ? (typeof order.delivery.selected_plan === 'string' ? JSON.parse(order.delivery.selected_plan) : order.delivery.selected_plan) : null;

        const deliveredAdvance = cashRecord ? cashRecord.amount : (deliveryPlan?.advance_payment || deliveryPlan?.advance_amount || deliveryPlan?.advancePayment || order.advance_amount);
        const productName = cashRecord?.product_name || deliveryPlan?.productName || order.product_name;
        const imei = cashRecord?.imei_serial || order.delivery.product_imei;

        // Split color/variant from CashInHand snapshot first
        let color = null;
        let variant = null;
        if (cashRecord?.color_variant) {
            const parts = cashRecord.color_variant.split('|').map(s => s.trim());
            color = parts[0] || 'N/A';
            variant = parts[1] || 'N/A';
        } else {
            color = deliveryPlan?.color || deliveryPlan?.productColor || null;
            variant = deliveryPlan?.variant || deliveryPlan?.productVariant || null;
        }

        // 3. Generate OTP for customer verification
        const otp = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit OTP

        // 4. Create PENDING record (Storing extra specs in selected_plan JSON to avoid schema conflicts)
        const returnRecord = await prisma.returnExchange.create({
            data: {
                order_id: parseInt(order_id),
                outlet_id: outlet_id,
                type: type,
                status: 'pending',
                otp: otp,
                product_name: productName,
                // We store these in selected_plan to ensure data is captured without needing immediate schema columns
                selected_plan: {
                    ...deliveryPlan,
                    delivered_color: color,
                    delivered_variant: variant,
                    delivered_advance_amount: parseFloat(deliveredAdvance) || 0
                },
                imei_returned: imei,
                is_cash_refund: !!is_cash_refund,
                refund_amount: parseFloat(refund_amount) || 0,
                initiated_by: "Outlet"
            }
        });

        // 5. Send OTP to Customer (Purchaser) via WhatsApp
        const customerPhone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;

        if (customerPhone) {
            try {
                await sendOTP(customerPhone, otp);
                console.log(`Sales Return OTP ${otp} sent to customer at ${customerPhone}`);
            } catch (err) {
                console.error('Error sending Sales Return OTP to customer:', err);
            }
        }

        // 6. Socket Notification for Real-time Dashboard Update
        const io = req.app.get('io');
        if (io) {
            io.to(`outlet_${outlet_id}`).emit('return_exchange_requested', {
                target_outlet_id: parseInt(outlet_id),
                record_id: returnRecord.id,
                officer_name: "Outlet",
                type,
                otp,
                order_ref: order.order_ref,
                product_name: productName,
                color: color,
                variant: variant,
                delivered_advance: deliveredAdvance,
                imei: imei || null,
                is_cash_refund: returnRecord.is_cash_refund,
                refund_amount: returnRecord.refund_amount
            });
        }

        return res.json({
            success: true,
            message: `OTP generated and sent to customer's WhatsApp. Please verify to complete the Sales Return.`,
            data: { record_id: returnRecord.id }
        });

    } catch (error) {
        console.error('initiateDirectReturn error:', error);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
};

const getAllOutlets = async (req, res) => {
    try {
        const { code, status } = req.query;
        const where = {};

        if (code) {
            where.code = { contains: code };
        }

        if (status) {
            where.status = status;
        }

        const outlets = await prisma.outlet.findMany({
            where,
            orderBy: { created_at: 'desc' }
        });

        res.json({ success: true, data: outlets });
    } catch (error) {
        console.error('getAllOutlets error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const searchDeliveredOrders = async (req, res) => {
    const outlet_id = req.user.outlet_id;
    const { query } = req.query;

    if (!query || query.length < 3) {
        return res.json({ success: true, data: [] });
    }

    try {
        const orders = await prisma.order.findMany({
            where: {
                outlet_id: outlet_id,
                delivery: { status: 'completed' },
                OR: [
                    { order_ref: { contains: query } },
                    { customer_name: { contains: query } },
                    { product_name: { contains: query } },
                    {
                        delivery: {
                            product_imei: { contains: query }
                        }
                    }
                ]
            },
            include: {
                delivery: true,
                cash_in_hand: {
                    take: 1,
                    orderBy: { created_at: 'desc' }
                }
            },
            take: 10
        });

        // Map through orders to provide explicit "delivered" fields for the UI
        const refinedOrders = orders.map(order => {
            const delivery = order.delivery;
            const cashRecord = order.cash_in_hand?.[0]; // The official financial snapshot of delivery
            const plan = delivery?.selected_plan
                ? (typeof delivery.selected_plan === 'string'
                    ? JSON.parse(delivery.selected_plan)
                    : delivery.selected_plan)
                : null;

            // Advance: Prioritize the actual cash collected in CashInHand
            const deliveredAdvance = cashRecord ? cashRecord.amount : (plan?.advance_payment || plan?.advance_amount || plan?.advancePayment || 0);

            // Product specs: Prioritize the snapshot taken during delivery (CashInHand)
            const deliveredProd = cashRecord?.product_name || plan?.productName || order.product_name;
            const deliveredImei = cashRecord?.imei_serial || delivery?.product_imei || order.imei_serial || 'N/A';

            // Handle color/variant from CashInHand snapshot first
            let deliveredColor = 'N/A';
            let deliveredVariant = 'N/A';

            if (cashRecord?.color_variant) {
                // CashInHand often stores "Blue | 128GB"
                const parts = cashRecord.color_variant.split('|').map(s => s.trim());
                deliveredColor = parts[0] || 'N/A';
                deliveredVariant = parts[1] || 'N/A';
            } else {
                deliveredColor = plan?.color || plan?.productColor || 'N/A';
                deliveredVariant = plan?.variant || plan?.productVariant || 'N/A';
            }

            return {
                ...order,
                delivered_product_name: deliveredProd,
                delivered_color: deliveredColor,
                delivered_variant: deliveredVariant,
                delivered_imei: deliveredImei,
                delivered_advance: deliveredAdvance
            };
        });

        return res.json({ success: true, data: refinedOrders });
    } catch (error) {
        console.error('searchDeliveredOrders error:', error);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
};

const getOutletInstallments = async (req, res) => {
    const { outlet_id } = req.user;
    const {
        page = 1,
        limit = 10,
        search = '',
        tab = 'fresh', // 'fresh' or 'overdue'
        startDate,
        endDate
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;
    const q = search.trim();

    try {
        const orderWhere = {
            is_delivered: true,
            ...(outlet_id && { outlet_id: outlet_id }),
            ...(q && {
                OR: [
                    { customer_name: { contains: q } },
                    { order_ref: { contains: q } },
                    { whatsapp_number: { contains: q } },
                    { delivery: { product_imei: { contains: q } } },
                ],
            }),
        };

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Fetch all candidates first to filter by ledger rows (since they are JSON)
        // If the dataset is huge, this might need optimization but for most cases it's fine
        const allOrdersForTotalCount = await prisma.order.findMany({
            where: orderWhere,
            include: {
                delivery: {
                    include: {
                        installment_ledger: true
                    }
                }
            }
        });

        // Categorize orders into fresh, overdue, and fully paid
        const categorized = allOrdersForTotalCount.map(order => {
            const ledger = order.delivery?.installment_ledger;
            if (!ledger || !ledger.ledger_rows) return { orderId: order.id, isOverdue: false, isFullyPaid: false, nextDueDate: null };

            let rows = [];
            try {
                const rowsRaw = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : JSON.parse(ledger.ledger_rows);
                rows = normalizeLedger(rowsRaw);
            } catch (e) { return { orderId: order.id, isOverdue: false, isFullyPaid: false, nextDueDate: null }; }

            const installments = rows.filter(r => r.month > 0);

            const isFullyPaid = installments.length > 0 && installments.every(r => r.status === 'paid' || r.status === 'Paid');

            const isOverdue = !isFullyPaid && installments.some(r => {
                const dueDate = new Date(r.due_date || r.dueDate);
                return (r.status !== 'paid' && r.status !== 'Paid') && dueDate < today;
            });

            // Find next pending due date for filtering
            const nextPending = installments.find(r => r.status !== 'paid' && r.status !== 'Paid');
            const nextDueDate = nextPending ? new Date(nextPending.due_date || nextPending.dueDate) : null;

            return { orderId: order.id, isOverdue, isFullyPaid, nextDueDate };
        });

        const overdueIds = categorized.filter(c => c.isOverdue).map(c => c.orderId);
        const completedIds = categorized.filter(c => c.isFullyPaid).map(c => c.orderId);
        const freshIds = categorized.filter(c => !c.isOverdue && !c.isFullyPaid).map(c => c.orderId);

        // Apply Tab Filter
        let filteredIds = [];
        if (tab === 'overdue') filteredIds = overdueIds;
        else if (tab === 'completed') filteredIds = completedIds;
        else filteredIds = freshIds; // default to fresh

        // Apply Date Filter (based on next pending installment's due date)
        if (startDate || endDate) {
            const start = startDate ? new Date(startDate) : null;
            const end = endDate ? new Date(endDate) : null;

            filteredIds = categorized
                .filter(c => filteredIds.includes(c.orderId))
                .filter(c => {
                    if (!c.nextDueDate) return false;
                    if (start && c.nextDueDate < start) return false;
                    if (end && c.nextDueDate > end) return false;
                    return true;
                })
                .map(c => c.orderId);
        }

        // Ensure no undefined IDs slip through
        filteredIds = filteredIds.filter(id => id !== undefined && id !== null);

        const totalOrders = filteredIds.length;
        const orders = await prisma.order.findMany({
            where: { id: { in: filteredIds } },
            include: {
                verification: {
                    include: {
                        purchaser: true,
                        grantors: true,
                        documents: {
                            where: { label: { in: ['Purchaser Profile', 'Grantor 1 Profile', 'Grantor 2 Profile', 'Purchaser Face Photo'] } },
                            orderBy: { uploaded_at: 'desc' }
                        }
                    },
                },
                delivery: {
                    include: {
                        installment_ledger: {
                            include: {
                                consumer_numbers: {
                                    take: 1,
                                    orderBy: { created_at: 'desc' },
                                    select: {
                                        id: true,
                                        consumer_number: true,
                                    }
                                }
                            }
                        },
                    },
                },
                recovery_officer: {
                    select: {
                        id: true,
                        full_name: true,
                        phone: true
                    }
                },
                cash_in_hand: {
                    take: 1,
                    orderBy: { created_at: 'desc' },
                },
                outlet: {
                    select: {
                        name: true,
                        code: true
                    }
                }
            },
            orderBy: { created_at: 'desc' },
            skip,
            take: limitNum,
        });

        // Calculate Total Recovery for the current filtered view
        let totalRecovery = 0;
        allOrdersForTotalCount.filter(o => filteredIds.includes(o.id)).forEach(order => {
            const ledger = order.delivery?.installment_ledger;
            if (!ledger || !ledger.ledger_rows) return;
            try {
                const rowsRaw = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : JSON.parse(ledger.ledger_rows);
                const rows = normalizeLedger(rowsRaw);
                rows.filter(r => r.month > 0).forEach(r => {
                    const rowPaidAmount = Number(r.paid_amount || (r.status === 'paid' ? (r.amount || 0) : 0));
                    totalRecovery += rowPaidAmount;
                });
            } catch (e) { }
        });


        // ── Pre-fetch Inventory details based on IMEI ──────────────────
        const allImeis = orders
            .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
            .filter(Boolean);

        const inventories = await prisma.outletInventory.findMany({
            where: { imei_serial: { in: allImeis } },
            select: { imei_serial: true, product_name: true }
        });

        const inventoryMap = new Map();
        for (const inv of inventories) {
            if (inv.imei_serial) {
                inventoryMap.set(inv.imei_serial, inv);
            }
        }

        const formatted = orders.map(order => {
            const purchaser = order.verification?.purchaser || null;
            const grantors = order.verification?.grantors || [];
            const documents = order.verification?.documents || [];
            const delivery = order.delivery;
            const ledgerModel = delivery?.installment_ledger || null;
            const cashRecord = order.cash_in_hand?.[0] || null;

            const imeiSerial = cashRecord?.imei_serial || delivery?.product_imei || order.imei_serial || null;
            const invInfo = imeiSerial ? inventoryMap.get(imeiSerial) : null;

            let plan = delivery?.selected_plan || null;
            if (typeof plan === 'string') {
                try { plan = JSON.parse(plan); } catch (e) { plan = null; }
            }

            const normalized = getNormalizedLedger(ledgerModel?.ledger_rows);
            const { advance_payment: advancePayment, installment_ledger: installmentLedger, summary } = normalized;

            const advanceAmount = advancePayment.amount;
            const monthlyAmount = installmentLedger[0]?.dueAmount || plan?.monthly_amount || plan?.monthlyAmount || order.monthly_amount || 0;
            const totalMonths = installmentLedger.length || plan?.months || plan?.duration || order.months || 0;

            return {
                order_id: order.id,
                order_ref: order.order_ref,
                customer_name: purchaser?.name || order.customer_name,
                whatsapp_number: order.whatsapp_number,
                product_name: invInfo?.product_name || cashRecord?.product_name || order.product_name,
                imei_serial: imeiSerial,
                status: order.status,
                created_at: order.created_at,
                outlet_name: order.outlet?.name || 'N/A',
                outlet_code: order.outlet?.code || 'N/A',
                purchaser: {
                    ...purchaser,
                    profile_photo: documents.find(d => d.label === 'Purchaser Profile' || d.label === 'Purchaser Face Photo')?.file_url || null
                },
                grantors: grantors.map(g => ({
                    ...g,
                    profile_photo: documents.find(d => d.label === `Grantor ${g.grantor_number} Profile`)?.file_url || null
                })),
                ledgerSummaries: {
                    advanceAmount,
                    monthlyAmount,
                    totalMonths,
                    totalInstallmentDue: summary.totalInstallmentDue,
                    totalInstallmentPaid: summary.totalInstallmentPaid,
                    totalRemaining: summary.totalInstallmentRemaining,
                    totalArrears: summary.totalArrears,
                    paidInstallments: summary.paidInstallments,
                    totalInstallments: installmentLedger.length,
                },
                installmentLedger,
                ledger_short_id: ledgerModel?.token || null,
                consumer_number: ledgerModel?.consumer_numbers?.[0]?.consumer_number || null,
                consumer_bill_status: ledgerModel?.consumer_numbers?.[0]?.bill_status || null,
                recovery_officer: order.recovery_officer ? {
                    id: order.recovery_officer.id,
                    name: order.recovery_officer.full_name,
                    phone: order.recovery_officer.phone
                } : null
            };
        });

        res.json({
            success: true,
            data: {
                installments: formatted,
                totalRecovery,
                overdueCount: overdueIds.length,
                pagination: {
                    total: totalOrders,
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.ceil(totalOrders / limitNum),
                }
            }
        });
    } catch (error) {
        console.error('getOutletInstallments error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// =====================
// INSTALLMENT PAYMENT MODULE (OUTLET)
// =====================

const generateInstallmentOtp = async (req, res) => {
    const { order_id } = req.body;

    try {
        const order = await prisma.order.findUnique({
            where: { id: parseInt(order_id) },
            include: {
                verification: { include: { purchaser: true } }
            }
        });

        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
        if (!phone) return res.status(400).json({ success: false, message: 'Customer phone number not found' });

        const otp = await saveOTP(phone, 'installment_payment');
        await sendOTP(phone, otp);

        return res.json({ success: true, message: 'OTP sent to customer' });
    } catch (error) {
        console.error('generateInstallmentOtp error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const verifyInstallmentPayment = async (req, res) => {
    const { order_id, month_number, feedback, payment_method = 'Cash', amount } = req.body;
    const outlet_id = req.user.outlet_id;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user' });

    try {
        const order = await prisma.order.findUnique({
            where: { id: parseInt(order_id) },
            include: {
                verification: { include: { purchaser: true } },
                installment_ledger: true,
                delivery: true,
                cash_in_hand: { orderBy: { created_at: 'desc' }, take: 1 }
            }
        });

        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;

        const ledger = order.installment_ledger;
        if (!ledger) return res.status(404).json({ success: false, message: 'Ledger not found' });

        let rows = normalizeLedger(Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : []);
        const rowIndex = rows.findIndex(r => (r.month == month_number || r.monthNumber == month_number));

        if (rowIndex === -1) return res.status(404).json({ success: false, message: 'Installment month not found in ledger' });
        if (rows[rowIndex].status === 'paid') return res.status(400).json({ success: false, message: 'Installment already paid' });

        // Update row
        const dueAmount = parseFloat(rows[rowIndex].amount || rows[rowIndex].dueAmount || 0);
        const existingPaid = parseFloat(rows[rowIndex].paid_amount || 0);
        const payingNow = amount !== undefined ? parseFloat(amount) : (dueAmount - existingPaid);
        const totalPaid = existingPaid + payingNow;

        if (totalPaid > dueAmount + 1) {
            return res.status(400).json({ success: false, message: `Payment exceeds due amount. Remaining is ${dueAmount - existingPaid}` });
        }

        // Maintain strict payment history of dates and amounts for partial/full payment tracking
        if (!rows[rowIndex].payment_history) {
            rows[rowIndex].payment_history = [];
            if (existingPaid > 0) {
                rows[rowIndex].payment_history.push({
                    amount: existingPaid,
                    date: rows[rowIndex].paid_at || new Date(),
                    method: rows[rowIndex].payment_method || 'Cash'
                });
            }
        }
        rows[rowIndex].payment_history.push({
            amount: payingNow,
            date: new Date(),
            method: payment_method
        });

        rows[rowIndex].paid_amount = totalPaid;
        rows[rowIndex].paid_at = new Date();
        rows[rowIndex].payment_method = payment_method;
        rows[rowIndex].feedback = feedback;

        if (totalPaid >= dueAmount) {
            rows[rowIndex].status = 'paid';
        } else if (totalPaid > 0) {
            rows[rowIndex].status = 'partial';
        } else {
            rows[rowIndex].status = 'pending';
        }

        // Save Ledger
        await prisma.installmentLedger.update({
            where: { id: ledger.id },
            data: { ledger_rows: rows }
        });

        // Update Cash Register (Only for Cash payments)
        const isCash = ['cash', 'recovery_cash', 'recovery cash'].includes(payment_method?.toLowerCase() || 'cash');
        if (isCash) {
            await updateCashRegister(null, outlet_id, 'installments_received', payingNow, 'add');
        }

        // Fetch real product name from inventory using IMEI
        const imeiSerial = order.cash_in_hand?.[0]?.imei_serial || order.delivery?.product_imei || order.imei_serial || null;
        let finalProductName = order.product_name;

        if (imeiSerial) {
            const invInfo = await prisma.outletInventory.findFirst({
                where: { imei_serial: imeiSerial },
                select: { product_name: true }
            });
            if (invInfo?.product_name) {
                finalProductName = invInfo.product_name;
            }
        }

        // Send Wati Receipt
        const customerName = order.verification?.purchaser?.name || order.customer_name;
        if (totalPaid >= dueAmount) {
            sendInstallmentPaymentReceipt(phone, {
                customerName,
                amount: payingNow,
                productName: finalProductName,
                orderRef: order.order_ref,
                date: new Date().toLocaleDateString('en-PK')
            }).catch(err => console.error('Wati Receipt Error:', err));
        } else {
            sendPartialInstallmentPaymentReceipt(phone, {
                customerName,
                paidAmount: payingNow,
                remainingAmount: Math.max(0, dueAmount - totalPaid),
                productName: finalProductName,
                orderRef: order.order_ref,
                dueDate: new Date(rows[rowIndex].due_date || rows[rowIndex].dueDate).toLocaleDateString('en-PK')
            }).catch(err => console.error('Wati Partial Receipt Error:', err));
        }

        // Send Next Month Reminder if exists
        const nextRow = rows[rowIndex + 1];
        if (nextRow) {
            sendNextInstallmentReminder(phone, {
                customerName,
                productName: finalProductName,
                monthlyAmount: nextRow.amount || nextRow.dueAmount,
                dueDate: new Date(nextRow.due_date || nextRow.dueDate).toLocaleDateString('en-PK'),
                ledgerUrl: ledger.token ? `${ledger.token}` : null
            }).catch(err => console.error('Wati Reminder Error:', err));
        }

        return res.json({ success: true, message: 'Payment processed successfully' });
    } catch (error) {
        console.error('verifyInstallmentPayment error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getOutletOfficers = async (req, res) => {
    const { role_id } = req.query; // 1 for VO, 2 for DO, 3 for RO
    const outletId = req.user.outlet_id;

    if (!role_id) return res.status(400).json({ success: false, message: 'role_id is required' });

    try {
        const officers = await prisma.user.findMany({
            where: {
                outlet_id: outletId,
                role_id: parseInt(role_id)
            },
            select: {
                id: true,
                full_name: true,
                phone: true,
                username: true,
                image: true,
                status: true,
                created_at: true
            }
        });

        const officersWithStats = await Promise.all(officers.map(async (off) => {
            const role = parseInt(role_id);

            if (role === 1) {
                // For Verification Officers - Get stats from Order table
                const orders = await prisma.order.findMany({
                    where: {
                        verification: {
                            verification_officer_id: off.id
                        }
                    },
                    select: {
                        status: true,
                        is_delivered: true
                    }
                });

                // Calculate stats based on Order status
                const pendingCount = orders.filter(o =>
                    o.status === 'Pending Verification' ||
                    o.status === 'pending' ||
                    o.status === 'new'
                ).length;

                const inProgressCount = orders.filter(o =>
                    o.status === 'Verification In Progress' ||
                    o.status === 'in_progress' ||
                    o.status === 'In Progress'
                ).length;

                const completedCount = orders.filter(o =>
                    o.status === 'Verified' ||
                    o.status === 'verified' ||
                    o.status === 'Approved' ||
                    o.status === 'approved'
                ).length;

                const rejectedCount = orders.filter(o =>
                    o.status === 'Rejected' ||
                    o.status === 'rejected'
                ).length;

                const expiredCount = orders.filter(o =>
                    o.status === 'Expired' ||
                    o.status === 'expired'
                ).length;

                const deliveredCount = orders.filter(o => o.is_delivered === true).length;

                const approvedCount = orders.filter(o =>
                    o.status === 'Approved' ||
                    o.status === 'approved' ||
                    o.status === 'Ready for Delivery'
                ).length;

                return {
                    ...off,
                    verified_count: completedCount,
                    orders: {
                        total: orders.length,
                        pending: pendingCount,
                        in_progress: inProgressCount,
                        completed: completedCount,
                        rejected: rejectedCount,
                        expired: expiredCount,
                        delivered: deliveredCount,
                        approved: approvedCount
                    }
                };
            } else {
                // For Delivery and Recovery Officers (existing logic)
                // 1. Exact Cash Aggregation
                // Paid: Sum of verified histories
                const paidSum = await prisma.cashSubmissionHistory.aggregate({
                    where: {
                        cash_in_hand: { officer_id: off.id },
                        status: 'paid'
                    },
                    _sum: { amount_submitted: true }
                });
                const paidAmount = paidSum._sum.amount_submitted || 0;

                // Pending: sum of (amount - submitted_amount) for pending rows
                const pendingItems = await prisma.cashInHand.findMany({
                    where: { officer_id: off.id, status: 'pending' }
                });
                const pendingAmount = pendingItems.reduce((acc, curr) => acc + (curr.amount - curr.submitted_amount), 0);

                // 2. Orders stats (Units Delivered or Paid Submissions)
                let deliveredCount = 0;
                if (role === 3) {
                    // For RO: Count successful paid submissions
                    deliveredCount = await prisma.cashSubmissionHistory.count({
                        where: {
                            cash_in_hand: { officer_id: off.id },
                            status: 'paid'
                        }
                    });
                } else {
                    // For DO: Count delivered orders
                    deliveredCount = await prisma.order.count({
                        where: {
                            delivery_officer_id: off.id,
                            is_delivered: true
                        }
                    });
                }

                // 3. Stock stats (for DO)
                let stockCount = 0;
                if (role === 2) {
                    stockCount = await prisma.stockTransfer.count({
                        where: {
                            to_id: off.id,
                            to_type: 'Delivery Officer',
                            inventory: {
                                status: 'Out Of Stock'
                            }
                        }
                    });
                }

                return {
                    ...off,
                    paid_cash: paidAmount,
                    pending_cash: pendingAmount,
                    total_collection: paidAmount + pendingAmount,
                    stock_count: stockCount,
                    orders: {
                        delivered: deliveredCount
                    }
                };
            }
        }));

        res.json({ success: true, officers: officersWithStats });
    } catch (error) {
        console.error('getOutletOfficers error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getOfficerDetails = async (req, res) => {
    const { id } = req.params;
    const outletId = req.user.outlet_id;

    try {
        const officer = await prisma.user.findUnique({
            where: { id: parseInt(id) },
            select: { id: true, full_name: true, phone: true, role_id: true, outlet_id: true }
        });

        if (!officer || (officer.outlet_id !== outletId && req.user.role_id !== 7)) {
            return res.status(403).json({ success: false, message: 'Unauthorized access to officer details' });
        }

        const role = officer.role_id;

        const [inventory, delivered_products, cash, paidSumRes, submissionHistory, ordersForVO, assignedOrders] = await Promise.all([
            // 1. Inventory in hand (Only for DO)
            role === 2 ? prisma.stockTransfer.findMany({
                where: {
                    to_id: officer.id,
                    to_type: 'Delivery Officer',
                    inventory: { status: 'Out Of Stock' }
                },
                include: { inventory: true },
                orderBy: { created_at: 'desc' }
            }) : Promise.resolve([]),

            // 2. Delivered Products (Only for DO)
            role === 2 ? prisma.delivery.findMany({
                where: { delivery_agent_id: officer.id },
                include: {
                    order: {
                        select: { order_ref: true, customer_name: true, product_name: true, created_at: true }
                    }
                },
                orderBy: { created_at: 'desc' }
            }) : Promise.resolve([]),

            // 3. Cash in hand list (All collections)
            prisma.cashInHand.findMany({
                where: { officer_id: officer.id },
                include: {
                    order: { select: { order_ref: true } }
                },
                orderBy: { created_at: 'desc' }
            }),

            // 4. Paid Sum
            prisma.cashSubmissionHistory.aggregate({
                where: {
                    cash_in_hand: { officer_id: officer.id },
                    status: 'paid'
                },
                _sum: { amount_submitted: true }
            }),

            // 5. Submission History (Live Ledger)
            prisma.cashSubmissionHistory.findMany({
                where: { cash_in_hand: { officer_id: officer.id } },
                include: {
                    cash_in_hand: {
                        include: { order: { select: { order_ref: true } } }
                    }
                },
                orderBy: { submission_date: 'desc' },
                take: 100
            }),

            // 6. Orders for VO (role_id = 1) - Directly from Order table with verification relation
            role === 1 ? prisma.order.findMany({
                where: {
                    verification: {
                        verification_officer_id: officer.id
                    }
                },
                include: {
                    verification: true
                },
                orderBy: { created_at: 'desc' }
            }) : Promise.resolve([]),

            // 7. Assigned Orders for DO and RO
            (role === 2 || role === 3) ? prisma.order.findMany({
                where: role === 2
                    ? { delivery_officer_id: officer.id }
                    : { recovery_officer_id: officer.id },
                select: {
                    id: true,
                    order_ref: true,
                    customer_name: true,
                    product_name: true,
                    status: true,
                    is_delivered: true,
                    created_at: true,
                    address: true,
                    area: true
                },
                orderBy: { created_at: 'desc' },
                take: 50
            }) : Promise.resolve([])
        ]);

        const paidAmount = paidSumRes._sum.amount_submitted || 0;
        const pendingAmount = cash.reduce((acc, curr) => {
            if (curr.status === 'pending') acc += (curr.amount - curr.submitted_amount);
            return acc;
        }, 0);

        // Count order statuses for VO (from Order table, not Verification table)
        const verificationStats = {
            pending: ordersForVO.filter(o => o.status === 'pending').length,
            in_progress: ordersForVO.filter(o => o.status === 'in_progress').length,
            completed: ordersForVO.filter(o => o.status === 'completed').length,
            approved: ordersForVO.filter(o => o.status === 'approved').length,
            delivered: ordersForVO.filter(o => o.status === 'delivered').length,
            rejected: ordersForVO.filter(o => o.status === 'rejected').length,
            expired: ordersForVO.filter(o => o.status === 'expired').length
        };

        // Format orders for VO response
        const formattedOrdersForVO = role === 1 ? ordersForVO.map(order => ({
            id: order.id,
            order_ref: order.order_ref,
            customer_name: order.customer_name,
            product_name: order.product_name,
            status: order.status,
            is_delivered: order.is_delivered,
            created_at: order.created_at,
            cancelled_at: order.cancelled_at,
            verification_status: order.verification?.status,
            verification_start_time: order.verification?.start_time,
            verification_end_time: order.verification?.end_time,
            home_location_verified: order.verification?.home_location_verified,
            verification_feedback: order.verification?.verification_feedback
        })) : null;

        res.json({
            success: true,
            officer,
            inventory: role === 2 ? inventory.map(t => t.inventory) : null,
            delivered_products: role === 2 ? delivered_products.map(d => ({
                order_ref: d.order.order_ref,
                customer_name: d.order.customer_name,
                product_name: d.order.product_name,
                imei_serial: d.product_imei,
                delivery_date: d.created_at
            })) : null,
            verifications: formattedOrdersForVO,
            cash,
            submission_history: submissionHistory.map(h => ({
                id: h.id,
                amount: h.amount_submitted,
                status: h.status,
                date: h.submission_date,
                order_ref: h.cash_in_hand?.order?.order_ref
            })),
            assigned_orders: assignedOrders,
            stats: {
                paid_cash: paidAmount,
                pending_cash: pendingAmount,
                total_collection: paidAmount + pendingAmount,
                verification_stats: verificationStats
            }
        });
    } catch (error) {
        console.error('getOfficerDetails error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getOutletInstallmentsDueList = async (req, res) => {
    const { outlet_id } = req.user;
    const {
        page = 1,
        limit = 10,
        search = '',
        tab = 'fresh', // 'fresh', 'due', 'completed'
        month,
        year
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;
    const q = search.trim().toLowerCase();

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Determine date range for chosen month & year
        const defaultYear = today.getFullYear();
        const defaultMonth = today.getMonth() + 1; // 1-indexed

        const filterMonth = month ? parseInt(month) : defaultMonth;
        const filterYear = year ? parseInt(year) : defaultYear;

        const start = new Date(filterYear, filterMonth - 1, 1);
        const end = new Date(filterYear, filterMonth, 0, 23, 59, 59, 999);

        // Fetch all delivered orders for the outlet
        const orders = await prisma.order.findMany({
            where: {
                is_delivered: true,
                ...(outlet_id && { outlet_id: outlet_id }),
            },
            include: {
                verification: {
                    include: {
                        purchaser: true,
                        grantors: true,
                        documents: {
                            where: { label: { in: ['Purchaser Profile', 'Grantor 1 Profile', 'Grantor 2 Profile', 'Purchaser Face Photo'] } },
                            orderBy: { uploaded_at: 'desc' }
                        }
                    },
                },
                delivery: {
                    include: {
                        installment_ledger: {
                            include: {
                                consumer_numbers: {
                                    take: 1,
                                    orderBy: { created_at: 'desc' },
                                    select: {
                                        id: true,
                                        consumer_number: true,
                                        bill_status: true,
                                        amount_due: true,
                                        billing_month: true,
                                        due_date: true
                                    }
                                }
                            }
                        },
                    },
                },
                recovery_officer: {
                    select: {
                        id: true,
                        full_name: true,
                        phone: true
                    }
                },
                cash_in_hand: {
                    take: 1,
                    orderBy: { created_at: 'desc' },
                }
            }
        });

        // ── Pre-fetch Inventory details based on IMEI to map product_name ──
        const allImeis = orders
            .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
            .filter(Boolean);

        const inventories = await prisma.outletInventory.findMany({
            where: { imei_serial: { in: allImeis } },
            select: { imei_serial: true, product_name: true }
        });

        const inventoryMap = new Map();
        for (const inv of inventories) {
            if (inv.imei_serial) {
                inventoryMap.set(inv.imei_serial, inv);
            }
        }

        // Stats aggregations
        let totalDueThisMonth = 0;
        let totalPaidThisMonth = 0;
        let overallSystemRemaining = 0;
        let overallSystemPaid = 0;

        const allInstallments = [];

        orders.forEach(order => {
            const purchaser = order.verification?.purchaser || null;
            const grantors = order.verification?.grantors || [];
            const documents = order.verification?.documents || [];
            const delivery = order.delivery;
            const ledgerModel = delivery?.installment_ledger || null;
            const cashRecord = order.cash_in_hand?.[0] || null;

            const imeiSerial = cashRecord?.imei_serial || delivery?.product_imei || order.imei_serial || null;
            const invInfo = imeiSerial ? inventoryMap.get(imeiSerial) : null;

            const normalized = getNormalizedLedger(ledgerModel?.ledger_rows);
            const { installment_ledger: installmentLedger, summary } = normalized;

            // Increment overall system stats
            overallSystemRemaining += summary.totalInstallmentRemaining;
            overallSystemPaid += summary.totalInstallmentPaid;

            // Parse raw ledger rows to extract specific installment-level notes
            let rawLedgerRows = [];
            try {
                if (ledgerModel?.ledger_rows) {
                    rawLedgerRows = Array.isArray(ledgerModel.ledger_rows)
                        ? ledgerModel.ledger_rows
                        : JSON.parse(ledgerModel.ledger_rows);
                }
            } catch (e) {
                console.error("Error parsing raw ledger rows:", e);
            }

            // Extract Guarantor 1 & Guarantor 2 separately
            const g1 = grantors.find(g => g.grantor_number === 1) || grantors[0] || null;
            const g2 = grantors.find(g => g.grantor_number === 2) || (grantors[0] && grantors[1] && grantors[0].id !== grantors[1].id ? grantors[1] : null);

            const g1Name = g1?.name || 'N/A';
            const g1Phone = g1?.telephone_number || 'N/A';
            const g2Name = g2?.name || 'N/A';
            const g2Phone = g2?.telephone_number || 'N/A';

            // Process each installment in the ledger
            installmentLedger.forEach(inst => {
                if (!inst.dueDate) return;
                const instDate = new Date(inst.dueDate);

                // Check if this installment falls in the selected month & year
                if (instDate >= start && instDate <= end) {
                    totalDueThisMonth += inst.dueAmount;
                    totalPaidThisMonth += inst.paidAmount;

                    // Extract alternate number
                    const altNum = purchaser?.alternate_contact || order.alternate_contact || 'N/A';
                    const customerArea = order.area || purchaser?.present_address || 'N/A';

                    // Find installment-specific note and payment history details
                    const matchedRawRow = rawLedgerRows.find(r => r.month === inst.monthNumber);
                    const installmentNote = matchedRawRow?.note || '';

                    const paymentHistory = matchedRawRow?.payment_history || (matchedRawRow?.paid_at ? [{
                        amount: matchedRawRow.paid_amount,
                        date: matchedRawRow.paid_at,
                        method: matchedRawRow.payment_method || 'Cash'
                    }] : []);

                    allInstallments.push({
                        order_id: order.id,
                        order_ref: order.order_ref,
                        customer_name: purchaser?.name || order.customer_name,
                        whatsapp_number: order.whatsapp_number,
                        alternate_number: altNum,
                        area: customerArea,
                        dueDate: inst.dueDate,
                        purchaseDate: order.created_at,
                        grantor1Name: g1Name,
                        grantor1Phone: g1Phone,
                        grantor2Name: g2Name,
                        grantor2Phone: g2Phone,
                        product_name: invInfo?.product_name || cashRecord?.product_name || order.product_name,
                        imei_serial: imeiSerial || 'N/A',
                        monthlyAmount: inst.dueAmount,
                        remainingAmount: summary.totalInstallmentRemaining, // remaining installment amount for order
                        partialPayment: (inst.paidAmount > 0 && inst.status !== 'paid') ? inst.paidAmount : (inst.status === 'paid' ? inst.dueAmount : null),
                        paidDate: matchedRawRow?.paid_at || inst.paidAt || null,
                        paymentHistory: paymentHistory,
                        note: installmentNote,
                        monthNumber: inst.monthNumber,
                        status: inst.status || 'pending',
                        dueDateObj: instDate,
                        consumer_number: ledgerModel?.consumer_numbers?.[0]?.consumer_number || null,
                        consumer_bill_status: ledgerModel?.consumer_numbers?.[0]?.bill_status || null,
                        recovery_officer: order.recovery_officer ? {
                            id: order.recovery_officer.id,
                            name: order.recovery_officer.full_name,
                            phone: order.recovery_officer.phone
                        } : null
                    });
                }
            });
        });

        // Sort by Due Date (ascending)
        allInstallments.sort((a, b) => a.dueDateObj - b.dueDateObj);

        // Apply Tab Filter
        let filtered = allInstallments;
        if (tab === 'completed') {
            filtered = allInstallments.filter(inst => inst.status === 'paid');
        } else if (tab === 'due') {
            filtered = allInstallments.filter(inst => inst.status !== 'paid' && inst.dueDateObj < today);
        } else if (tab === 'fresh') {
            filtered = allInstallments.filter(inst => inst.status !== 'paid' && inst.dueDateObj >= today);
        }

        // Apply Search Filter
        if (q) {
            filtered = filtered.filter(inst => {
                return (
                    (inst.order_ref || '').toLowerCase().includes(q) ||
                    (inst.customer_name || '').toLowerCase().includes(q) ||
                    (inst.whatsapp_number || '').toLowerCase().includes(q) ||
                    (inst.alternate_number || '').toLowerCase().includes(q) ||
                    (inst.area || '').toLowerCase().includes(q) ||
                    (inst.grantor1Name || '').toLowerCase().includes(q) ||
                    (inst.grantor2Name || '').toLowerCase().includes(q) ||
                    (inst.product_name || '').toLowerCase().includes(q) ||
                    (inst.imei_serial || '').toLowerCase().includes(q)
                );
            });
        }

        // Pagination
        const total = filtered.length;
        const totalPages = Math.ceil(total / limitNum);
        const paginated = filtered.slice(skip, skip + limitNum);

        res.json({
            success: true,
            data: {
                installments: paginated,
                stats: {
                    totalDueThisMonth,
                    totalPaidThisMonth,
                    remainingThisMonth: Math.max(0, totalDueThisMonth - totalPaidThisMonth),
                    overallSystemRemaining,
                    overallSystemPaid
                },
                pagination: {
                    total,
                    page: pageNum,
                    limit: limitNum,
                    totalPages
                }
            }
        });
    } catch (error) {
        console.error('getOutletInstallmentsDueList error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const updateInstallmentNote = async (req, res) => {
    const { id } = req.params; // Order ID
    const { note, month_number } = req.body;

    if (month_number === undefined || month_number === null) {
        return res.status(400).json({ success: false, message: 'month_number is required' });
    }

    try {
        // Fetch order with installment ledger
        const order = await prisma.order.findUnique({
            where: { id: parseInt(id) },
            include: {
                delivery: {
                    include: {
                        installment_ledger: true
                    }
                }
            }
        });

        const ledger = order?.delivery?.installment_ledger;
        if (!ledger) {
            return res.status(404).json({ success: false, message: 'Installment ledger not found' });
        }

        let rows = [];
        if (ledger.ledger_rows) {
            rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : JSON.parse(ledger.ledger_rows);
        }

        // Find the monthly installment row
        const targetRow = rows.find(r => r.month === parseInt(month_number));
        if (!targetRow) {
            return res.status(404).json({ success: false, message: `Installment for month ${month_number} not found` });
        }

        // Update note specifically for this installment month
        targetRow.note = note;

        // Save ledger rows back
        await prisma.installmentLedger.update({
            where: { id: ledger.id },
            data: { ledger_rows: rows }
        });

        res.json({ success: true, message: 'Installment note updated successfully' });
    } catch (error) {
        console.error('updateInstallmentNote error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    createOutlet,
    getOutlets,
    getAllOutlets,
    updateOutlet,
    loginOutletUser,
    getDashboardStats,
    getGlobalCashInHand,
    verifyCashSubmissionOTP,
    getOutletCashHistory,
    getReturnExchanges,
    verifyReturnExchangeOtp,
    initiateDirectReturn,
    searchDeliveredOrders,
    getOutletInstallments,
    generateInstallmentOtp,
    verifyInstallmentPayment,
    getOutletOfficers,
    getOfficerDetails,
    getOutletInstallmentsDueList,
    updateInstallmentNote
};