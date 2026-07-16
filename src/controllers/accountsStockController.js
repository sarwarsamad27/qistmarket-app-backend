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

const LOW_STOCK_THRESHOLD = 3;
const DEAD_STOCK_DAYS = 45;

/**
 * getInventoryHealthAlerts
 * Low-stock: fewer than LOW_STOCK_THRESHOLD "In Stock" units of a product
 * at an outlet. Dead-stock: "In Stock" items older than DEAD_STOCK_DAYS
 * with zero StockTransfer rows (no movement since arrival) — uses a
 * Prisma relation-count filter instead of a manual join.
 */
const getInventoryHealthAlerts = async (req, res) => {
    try {
        const cutoff = new Date(Date.now() - DEAD_STOCK_DAYS * 24 * 60 * 60 * 1000);

        const [stockGroups, deadStock] = await Promise.all([
            prisma.outletInventory.groupBy({
                by: ['outlet_id', 'product_name'],
                where: { status: 'In Stock' },
                _count: { id: true },
                having: { id: { _count: { lt: LOW_STOCK_THRESHOLD } } },
            }),
            prisma.outletInventory.findMany({
                where: { status: 'In Stock', created_at: { lte: cutoff }, stockTransfers: { none: {} } },
                include: { outlet: { select: { name: true } } },
                orderBy: { created_at: 'asc' },
                take: 100,
            }),
        ]);

        const outletIds = [...new Set(stockGroups.map((g) => g.outlet_id))];
        const outlets = outletIds.length ? await prisma.outlet.findMany({ where: { id: { in: outletIds } }, select: { id: true, name: true } }) : [];
        const outletNameById = Object.fromEntries(outlets.map((o) => [o.id, o.name]));

        res.json({
            success: true,
            data: {
                lowStock: stockGroups.map((g) => ({
                    outlet_id: g.outlet_id,
                    outlet_name: outletNameById[g.outlet_id] || 'Unassigned',
                    product_name: g.product_name,
                    inStock: g._count.id,
                    threshold: LOW_STOCK_THRESHOLD,
                })),
                deadStock: deadStock.map((d) => ({
                    id: d.id,
                    product_name: d.product_name,
                    imei_serial: d.imei_serial,
                    outlet_name: d.outlet?.name || 'Unassigned',
                    created_at: d.created_at,
                    daysInStock: Math.floor((Date.now() - new Date(d.created_at).getTime()) / 86400000),
                })),
            },
        });
    } catch (error) {
        console.error('getInventoryHealthAlerts error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getDamagedStockReport
 * "Damaged" is a plain status value (OutletInventory.status is free-text,
 * no schema change needed) alongside the existing "In Stock"/"Sold".
 */
const getDamagedStockReport = async (req, res) => {
    try {
        const items = await prisma.outletInventory.findMany({
            where: { status: 'Damaged' },
            include: { outlet: { select: { name: true } } },
            orderBy: { updated_at: 'desc' },
        });

        res.json({
            success: true,
            data: items.map((i) => ({
                id: i.id, product_name: i.product_name, imei_serial: i.imei_serial,
                outlet_name: i.outlet?.name || 'Unassigned', purchase_price: i.purchase_price, updated_at: i.updated_at,
            })),
        });
    } catch (error) {
        console.error('getDamagedStockReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * markItemDamaged
 * Flips a single inventory item's status to "Damaged" — global (any
 * outlet), unlike inventoryController's outlet-scoped bulk-edit, since
 * this is an Admin-level correction action.
 */
const markItemDamaged = async (req, res) => {
    try {
        const item = await prisma.outletInventory.findUnique({ where: { id: parseInt(req.params.id) } });
        if (!item) return res.status(404).json({ success: false, message: 'Item not found.' });

        await prisma.outletInventory.update({ where: { id: item.id }, data: { status: 'Damaged' } });
        res.json({ success: true, message: 'Item marked as damaged.' });
    } catch (error) {
        console.error('markItemDamaged error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getProductMovementReport
 * Fast-moving vs. slow-moving — sell-through in the last 30 days per
 * product, from OutletInventory.status transitions (updated_at bumps on
 * any change, so "Sold" + recently updated is used as the sale-event proxy).
 */
const getProductMovementReport = async (req, res) => {
    try {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const items = await prisma.outletInventory.findMany({ select: { product_name: true, status: true, updated_at: true } });

        const stats = {};
        for (const i of items) {
            if (!stats[i.product_name]) stats[i.product_name] = { product_name: i.product_name, inStock: 0, soldLast30Days: 0, totalSold: 0 };
            if (i.status === 'In Stock') stats[i.product_name].inStock += 1;
            if (i.status === 'Sold') {
                stats[i.product_name].totalSold += 1;
                if (new Date(i.updated_at) >= cutoff) stats[i.product_name].soldLast30Days += 1;
            }
        }

        const products = Object.values(stats).sort((a, b) => b.soldLast30Days - a.soldLast30Days);
        res.json({
            success: true,
            data: {
                fastMoving: products.filter((p) => p.soldLast30Days > 0).slice(0, 15),
                slowMoving: products.filter((p) => p.soldLast30Days === 0 && p.inStock > 0).slice(0, 15),
                all: products,
            },
        });
    } catch (error) {
        console.error('getProductMovementReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getProductPricingComparison
 * Read-only — compares the same product's installment_price across
 * outlets to spot inconsistencies. Deliberately not a bulk-edit tool:
 * the existing bulk-edit endpoint (inventoryController.bulkUpdateInventory)
 * is outlet-scoped by design, and building a global override would bypass
 * that scoping in a way that needs its own careful review, not a
 * side-effect of this pass.
 */
const getProductPricingComparison = async (req, res) => {
    try {
        const items = await prisma.outletInventory.findMany({
            where: { status: 'In Stock' },
            select: { product_name: true, installment_price: true, outlet: { select: { name: true } } },
        });

        const grouped = {};
        for (const i of items) {
            if (!grouped[i.product_name]) grouped[i.product_name] = { product_name: i.product_name, prices: [] };
            grouped[i.product_name].prices.push({ outlet_name: i.outlet?.name || 'Unassigned', price: i.installment_price });
        }

        const products = Object.values(grouped).map((g) => {
            const values = g.prices.map((p) => p.price);
            const min = Math.min(...values);
            const max = Math.max(...values);
            return { product_name: g.product_name, min, max, spread: max - min, hasInconsistency: max - min > 0, byOutlet: g.prices };
        }).sort((a, b) => b.spread - a.spread);

        res.json({ success: true, data: products });
    } catch (error) {
        console.error('getProductPricingComparison error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * searchByBarcode
 * Same pattern as searchByImei, over the new optional barcode field.
 */
const searchByBarcode = async (req, res) => {
    try {
        const { barcode } = req.params;
        if (!barcode || barcode.trim().length < 3) return res.status(400).json({ success: false, message: 'Enter at least 3 characters of the barcode.' });

        const items = await prisma.outletInventory.findMany({
            where: { barcode: { contains: barcode.trim() } },
            include: { outlet: { select: { name: true } } },
            take: 20,
        });

        res.json({
            success: true,
            data: items.map((i) => ({ id: i.id, barcode: i.barcode, product_name: i.product_name, status: i.status, outlet_name: i.outlet?.name })),
        });
    } catch (error) {
        console.error('searchByBarcode error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getWarehouseStockSummary,
    getStockTransfersOverview,
    getReturnItemsReport,
    searchByImei,
    getInventoryHealthAlerts,
    getDamagedStockReport,
    markItemDamaged,
    getProductMovementReport,
    getProductPricingComparison,
    searchByBarcode,
};
