const prisma = require('../../lib/prisma');
const { getOutletFilter } = require('../utils/outletFilter');

/**
 * getWarehouseStockSummary
 * Same shape as outletReportController.getStockSummary but scoped to
 * outlets tagged type="warehouse" (see the Outlet.type field) — the
 * central-warehouse counterpart to per-outlet stock.
 */
const getWarehouseStockSummary = async (req, res) => {
    try {
        const warehouses = await prisma.outlet.findMany({ where: { type: 'warehouse' }, select: { id: true, name: true } });
        const warehouseIds = warehouses.map((w) => w.id);

        if (warehouseIds.length === 0) {
            return res.json({ success: true, data: { warehouses: [], summary: [] } });
        }

        const inventory = await prisma.outletInventory.findMany({ where: { outlet_id: { in: warehouseIds } } });

        const summary = inventory.reduce((acc, item) => {
            const key = item.product_name;
            if (!acc[key]) acc[key] = { product: key, total: 0, inStock: 0, sold: 0, valuation: 0 };
            acc[key].total++;
            if (item.status === 'In Stock') { acc[key].inStock++; acc[key].valuation += item.purchase_price; }
            else if (item.status === 'Sold') acc[key].sold++;
            return acc;
        }, {});

        res.json({ success: true, data: { warehouses, summary: Object.values(summary) } });
    } catch (error) {
        console.error('getWarehouseStockSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getStockTransfersOverview
 * Global view of stock transfers (existing inventoryController transfer
 * flows are all outlet-scoped-only) with resolved outlet names.
 */
const getStockTransfersOverview = async (req, res) => {
    try {
        const { status, page = 1, limit = 25 } = req.query;
        const where = status ? { status } : {};
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [transfers, total] = await Promise.all([
            prisma.stockTransfer.findMany({
                where,
                include: { inventory: { select: { product_name: true, imei_serial: true, category: true } } },
                orderBy: { created_at: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.stockTransfer.count({ where }),
        ]);

        const outletIds = transfers.filter((t) => t.from_type === 'Outlet' || t.to_type === 'Outlet').flatMap((t) => [t.from_type === 'Outlet' ? t.from_id : null, t.to_type === 'Outlet' ? t.to_id : null]).filter(Boolean);
        const outlets = outletIds.length ? await prisma.outlet.findMany({ where: { id: { in: outletIds } }, select: { id: true, name: true } }) : [];
        const outletNameById = Object.fromEntries(outlets.map((o) => [o.id, o.name]));

        res.json({
            success: true,
            data: transfers.map((t) => ({
                id: t.id, status: t.status, quantity_transferred: t.quantity_transferred, created_at: t.created_at,
                product_name: t.inventory?.product_name, imei_serial: t.inventory?.imei_serial,
                from: t.from_type === 'Outlet' ? outletNameById[t.from_id] || 'Unknown Outlet' : t.from_type,
                to: t.to_type === 'Outlet' ? outletNameById[t.to_id] || 'Unknown Outlet' : t.to_type,
            })),
            pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error('getStockTransfersOverview error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getReturnItemsReport
 * Global (or single-outlet) view over ReturnExchange, with outlet-wise
 * counts and refund totals.
 */
const getReturnItemsReport = async (req, res) => {
    const outletFilter = getOutletFilter(req);

    try {
        const returns = await prisma.returnExchange.findMany({
            where: outletFilter,
            include: { outlet: { select: { name: true } }, order: { select: { order_ref: true, customer_name: true } } },
            orderBy: { created_at: 'desc' },
        });

        const outletMap = {};
        for (const r of returns) {
            const key = r.outlet_id;
            if (!outletMap[key]) outletMap[key] = { outlet_id: r.outlet_id, outlet_name: r.outlet?.name || 'Unassigned', count: 0, refundTotal: 0 };
            outletMap[key].count += 1;
            outletMap[key].refundTotal += r.refund_amount;
        }

        res.json({
            success: true,
            data: {
                items: returns.map((r) => ({
                    id: r.id, order_ref: r.order?.order_ref, customer_name: r.order?.customer_name, outlet_name: r.outlet?.name,
                    type: r.type, status: r.status, imei_returned: r.imei_returned, is_cash_refund: r.is_cash_refund,
                    refund_amount: r.refund_amount, created_at: r.created_at, verified_at: r.verified_at,
                })),
                outletWise: Object.values(outletMap),
            },
        });
    } catch (error) {
        console.error('getReturnItemsReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * searchByImei
 * Consolidated IMEI lookup — current inventory record, any PayTrigger
 * device state, and any return history — one search box instead of
 * three separate lookups.
 */
const searchByImei = async (req, res) => {
    try {
        const { imei } = req.params;
        if (!imei || imei.trim().length < 4) return res.status(400).json({ success: false, message: 'Enter at least 4 digits of the IMEI.' });

        const cleanImei = imei.trim();

        const [inventoryItems, payTriggerDevice, returns] = await Promise.all([
            prisma.outletInventory.findMany({ where: { imei_serial: { contains: cleanImei } }, include: { outlet: { select: { name: true } } }, take: 20 }),
            prisma.payTriggerDevice.findFirst({ where: { imei: cleanImei } }),
            prisma.returnExchange.findMany({ where: { imei_returned: { contains: cleanImei } }, include: { outlet: { select: { name: true } } }, take: 10 }),
        ]);

        res.json({
            success: true,
            data: {
                inventory: inventoryItems.map((i) => ({ id: i.id, imei_serial: i.imei_serial, product_name: i.product_name, status: i.status, outlet_name: i.outlet?.name })),
                payTriggerDevice: payTriggerDevice ? { imei: payTriggerDevice.imei, lock_status: payTriggerDevice.lock_status, enrollment_status: payTriggerDevice.enrollment_status, order_ref: payTriggerDevice.order_ref } : null,
                returns: returns.map((r) => ({ id: r.id, imei_returned: r.imei_returned, outlet_name: r.outlet?.name, status: r.status, created_at: r.created_at })),
            },
        });
    } catch (error) {
        console.error('searchByImei error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getWarehouseStockSummary,
    getStockTransfersOverview,
    getReturnItemsReport,
    searchByImei,
};
