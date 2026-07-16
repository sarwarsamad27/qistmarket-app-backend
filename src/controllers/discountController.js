const prisma = require('../../lib/prisma');
const { logAction } = require('../utils/auditLogger');

/**
 * Discount requests are a standalone tracking/approval tool — they record
 * who asked for what discount and why, and who approved/rejected it, but
 * do NOT automatically change the order's price. Wiring an approval into
 * the live order-pricing engine (CreateOrder.tsx's tiered EMI calculator)
 * would mean touching that flow's actual behavior, which is out of scope
 * here; the approved amount is applied manually by whoever processes it,
 * same as today, just now with a recorded approval trail.
 */
const createDiscountRequest = async (req, res) => {
    const { order_id, amount, reason } = req.body;
    if (!order_id || !amount || !reason) {
        return res.status(400).json({ success: false, message: 'order_id, amount, and reason are required.' });
    }

    try {
        const order = await prisma.order.findUnique({ where: { id: parseInt(order_id) }, select: { id: true, order_ref: true } });
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        const request = await prisma.discountRequest.create({
            data: { order_id: order.id, requested_by: req.user.id, amount: parseFloat(amount), reason },
        });

        await logAction(req, 'DISCOUNT_REQUESTED', `Discount of PKR ${amount} requested for order ${order.order_ref}. Reason: ${reason}`, request.id, 'DiscountRequest');

        res.status(201).json({ success: true, data: request });
    } catch (error) {
        console.error('createDiscountRequest error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getDiscountRequests = async (req, res) => {
    const { status } = req.query;
    try {
        const requests = await prisma.discountRequest.findMany({
            where: status ? { status } : {},
            orderBy: { created_at: 'desc' },
            take: 200,
        });

        const orderIds = [...new Set(requests.map((r) => r.order_id))];
        const userIds = [...new Set([...requests.map((r) => r.requested_by), ...requests.filter((r) => r.decided_by).map((r) => r.decided_by)])];

        const [orders, users] = await Promise.all([
            orderIds.length ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, order_ref: true, customer_name: true, total_amount: true } }) : [],
            userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, full_name: true } }) : [],
        ]);

        const orderById = Object.fromEntries(orders.map((o) => [o.id, o]));
        const userById = Object.fromEntries(users.map((u) => [u.id, u]));

        res.json({
            success: true,
            data: requests.map((r) => ({
                id: r.id,
                order: orderById[r.order_id] || null,
                requested_by_name: userById[r.requested_by]?.full_name || 'Unknown',
                amount: r.amount,
                reason: r.reason,
                status: r.status,
                decided_by_name: r.decided_by ? (userById[r.decided_by]?.full_name || 'Unknown') : null,
                decided_at: r.decided_at,
                decision_notes: r.decision_notes,
                created_at: r.created_at,
            })),
        });
    } catch (error) {
        console.error('getDiscountRequests error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const decideDiscountRequest = async (req, res) => {
    const { id } = req.params;
    const { decision, notes } = req.body;
    if (!['approved', 'rejected'].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'." });
    }

    try {
        const request = await prisma.discountRequest.findUnique({ where: { id: parseInt(id) } });
        if (!request) return res.status(404).json({ success: false, message: 'Discount request not found.' });
        if (request.status !== 'pending') return res.status(400).json({ success: false, message: 'This request has already been decided.' });

        const updated = await prisma.discountRequest.update({
            where: { id: request.id },
            data: { status: decision, decided_by: req.user.id, decided_at: new Date(), decision_notes: notes || null },
        });

        await logAction(req, `DISCOUNT_${decision.toUpperCase()}`, `Discount request #${request.id} (PKR ${request.amount}) ${decision}.${notes ? ` Notes: ${notes}` : ''}`, request.id, 'DiscountRequest');

        res.json({ success: true, data: updated });
    } catch (error) {
        console.error('decideDiscountRequest error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = { createDiscountRequest, getDiscountRequests, decideDiscountRequest };
