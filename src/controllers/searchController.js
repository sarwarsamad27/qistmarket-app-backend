const prisma = require('../../lib/prisma');
const { getNormalizedLedger } = require('../utils/ledgerUtils');

const globalSearch = async (req, res) => {
    const { query, type = 'all' } = req.query;
    if (!query || query.length < 3) {
        return res.json({ success: true, results: [] });
    }

    try {
        const baseWhere = {
            OR: [
                { order_ref: { contains: query } },
                { token_number: { contains: query } },
                { customer_name: { contains: query } },
                { whatsapp_number: { contains: query } },
                { imei_serial: { contains: query } },
                { address: { contains: query } },
                { verification: { purchaser: { name: { contains: query } } } },
                { verification: { purchaser: { cnic_number: { contains: query } } } },
                { verification: { purchaser: { telephone_number: { contains: query } } } },
                { delivery: { product_imei: { contains: query } } },
            ]
        };

        if (type === 'customers') {
            baseWhere.status = 'delivered';
        } else if (type === 'orders') {
            baseWhere.status = { not: 'delivered' };
        }

        // Base search in Orders
        const orders = await prisma.order.findMany({
            where: baseWhere,
            include: {
                verification: {
                    include: {
                        purchaser: true,
                        grantors: true,
                        documents: true,
                        verification_locations: {
                            include: { photos: true }
                        }
                    }
                },
                delivery: true,
                installment_ledger: true
            },
            take: 100
        });

        // Search in Verifications (Name, CNIC, Purchaser Phone)
        const purchaserMatches = await prisma.purchaserVerification.findMany({
            where: {
                OR: [
                    { name: { contains: query } },
                    { cnic_number: { contains: query } },
                    { telephone_number: { contains: query } }
                ]
            },
            include: {
                verification: {
                    include: {
                        order: {
                            include: {
                                installment_ledger: true,
                                delivery: true,
                                verification: { include: { purchaser: true, grantors: true, documents: true, verification_locations: { include: { photos: true } } } }
                            }
                        }
                    }
                }
            },
            take: 50
        });

        const grantorMatches = await prisma.grantorVerification.findMany({
            where: {
                OR: [
                    { name: { contains: query } },
                    { cnic_number: { contains: query } },
                    { telephone_number: { contains: query } }
                ]
            },
            include: {
                verification: {
                    include: {
                        order: {
                            include: {
                                installment_ledger: true,
                                delivery: true,
                                verification: { include: { purchaser: true, grantors: true, documents: true, verification_locations: { include: { photos: true } } } }
                            }
                        }
                    }
                }
            },
            take: 50
        });

        // Consolidate unique orders
        const orderResults = new Map();

        orders.forEach(o => orderResults.set(o.id, o));
        
        purchaserMatches.forEach(pm => {
            const order = pm.verification?.order;
            if (order) {
                if (type === 'customers' && order.status !== 'delivered') return;
                if (type === 'orders' && order.status === 'delivered') return;
                orderResults.set(order.id, order);
            }
        });

        grantorMatches.forEach(gm => {
            const order = gm.verification?.order;
            if (order) {
                if (type === 'customers' && order.status !== 'delivered') return;
                if (type === 'orders' && order.status === 'delivered') return;
                orderResults.set(order.id, order);
            }
        });

        const results = Array.from(orderResults.values()).map(order => {
            const purchaser = order.verification?.purchaser;

            let is_ledger_cleared = false;
            if (order.status === 'delivered') {
                const ledger = order.installment_ledger;
                if (ledger && ledger.ledger_rows) {
                    try {
                        const rows = Array.isArray(ledger.ledger_rows)
                            ? ledger.ledger_rows
                            : JSON.parse(ledger.ledger_rows);
                        const normalized = getNormalizedLedger(rows);
                        if (normalized && normalized.summary) {
                            is_ledger_cleared = normalized.summary.grandTotalRemaining <= 0;
                        }
                    } catch (e) {
                        console.error('Error normalizing ledger in globalSearch:', e);
                    }
                }
            }

            return {
                id: order.id,
                order_ref: order.order_ref,
                token_number: order.token_number,
                customer_name: purchaser?.name || order.customer_name,
                father_name: purchaser?.father_husband_name || 'N/A',
                whatsapp_number: purchaser?.telephone_number || order.whatsapp_number,
                status: order.status,
                product_name: order.product_name,
                imei_serial: order.delivery?.product_imei || order.imei_serial,
                address: purchaser?.present_address || order.address,
                ledger_short_id: order.installment_ledger?.short_id || null,
                is_ledger_cleared,
                verification: order.verification ? {
                    cnic: purchaser?.cnic_number,
                    purchaser: purchaser,
                    grantors: order.verification.grantors,
                    documents: order.verification.documents,
                    verification_locations: order.verification.verification_locations
                } : null
            };
        });

        res.json({ success: true, results });
    } catch (error) {
        console.error('Global Search Error:', error);
        res.status(500).json({ success: false, message: 'Search failed' });
    }
};

const checkCNICOrders = async (req, res) => {
    const { cnic, cnics } = req.body; // Accept single CNIC string OR array of CNICs

    // Normalise: single cnic → wrap in array; cnics array → use as-is
    let cnicList = [];
    if (cnic && typeof cnic === 'string' && cnic.trim()) {
        cnicList = [cnic.trim()];
    } else if (Array.isArray(cnics) && cnics.length > 0) {
        cnicList = cnics.filter(c => c && typeof c === 'string' && c.trim()).map(c => c.trim());
    }

    if (cnicList.length === 0) {
        return res.status(400).json({ success: false, message: 'A cnic string or cnics array is required' });
    }

    const isSingle = !!cnic && !cnics; // caller sent single cnic

    try {
        const results = {};

        for (const c of cnicList) {
            // Search for purchaser matches
            const purchaserMatches = await prisma.purchaserVerification.findMany({
                where: { cnic_number: c },
                include: {
                    verification: {
                        include: {
                            order: {
                                select: {
                                    id: true,
                                    order_ref: true,
                                    status: true,
                                    created_at: true
                                }
                            }
                        }
                    }
                }
            });

            // Search for grantor matches
            const grantorMatches = await prisma.grantorVerification.findMany({
                where: { cnic_number: c },
                include: {
                    verification: {
                        include: {
                            order: {
                                select: {
                                    id: true,
                                    order_ref: true,
                                    status: true,
                                    created_at: true
                                }
                            }
                        }
                    }
                }
            });

            const orders = new Map();

            purchaserMatches.forEach(pm => {
                if (pm.verification?.order) {
                    orders.set(pm.verification.order.id, {
                        ...pm.verification.order,
                        role: 'Purchaser'
                    });
                }
            });

            grantorMatches.forEach(gm => {
                if (gm.verification?.order) {
                    orders.set(gm.verification.order.id, {
                        ...gm.verification.order,
                        role: `Guarantor ${gm.grantor_number || ''}`.trim()
                    });
                }
            });

            results[c] = Array.from(orders.values());
        }

        // If caller sent a single cnic, return a flat array for convenience
        if (isSingle) {
            return res.json({ success: true, results: results[cnicList[0]] });
        }

        res.json({ success: true, results });
    } catch (error) {
        console.error('Check CNIC Orders Error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const checkPhoneOrders = async (req, res) => {
    const { phone } = req.body;

    if (!phone) {
        return res.status(400).json({ success: false, message: 'Phone number is required' });
    }

    try {
        // Search in Orders (whatsapp_number)
        const directOrders = await prisma.order.findMany({
            where: { whatsapp_number: phone },
            select: {
                id: true,
                order_ref: true,
                status: true,
                created_at: true,
                customer_name: true
            }
        });

        // Search in Purchaser Verifications
        const purchaserMatches = await prisma.purchaserVerification.findMany({
            where: { telephone_number: phone },
            include: {
                verification: {
                    include: {
                        order: {
                            select: {
                                id: true,
                                order_ref: true,
                                status: true,
                                created_at: true,
                                customer_name: true
                            }
                        }
                    }
                }
            }
        });

        // Search in Grantor Verifications
        const grantorMatches = await prisma.grantorVerification.findMany({
            where: { telephone_number: phone },
            include: {
                verification: {
                    include: {
                        order: {
                            select: {
                                id: true,
                                order_ref: true,
                                status: true,
                                created_at: true,
                                customer_name: true
                            }
                        }
                    }
                }
            }
        });

        const ordersMap = new Map();

        directOrders.forEach(o => {
            ordersMap.set(o.id, { ...o, role: 'Order Contact', is_blacklisted: false });
        });

        purchaserMatches.forEach(pm => {
            if (pm.verification?.order) {
                const o = pm.verification.order;
                ordersMap.set(o.id, { ...o, role: 'Purchaser', is_blacklisted: pm.is_blacklisted || false });
            }
        });

        grantorMatches.forEach(gm => {
            if (gm.verification?.order) {
                const o = gm.verification.order;
                ordersMap.set(o.id, { ...o, role: `Guarantor ${gm.grantor_number || ''}`.trim(), is_blacklisted: gm.is_blacklisted || false });
            }
        });

        const results = Array.from(ordersMap.values());

        res.json({ success: true, results });
    } catch (error) {
        console.error('Check Phone Orders Error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const buildVerificationRoleMap = async ({ cnic, phone }) => {
    const verificationRoleMap = new Map();

    const setRole = (verificationId, role, isBlacklisted) => {
        if (!verificationId) return;
        const existing = verificationRoleMap.get(verificationId);
        if (!existing || isBlacklisted) {
            verificationRoleMap.set(verificationId, {
                role,
                is_blacklisted: isBlacklisted || existing?.is_blacklisted || false,
            });
        }
    };

    if (cnic) {
        const purchaserMatches = await prisma.purchaserVerification.findMany({
            where: { cnic_number: cnic },
            select: { verification_id: true, is_blacklisted: true, name: true },
        });
        purchaserMatches.forEach(pm => {
            setRole(pm.verification_id, 'Purchaser', pm.is_blacklisted);
        });

        const grantorMatches = await prisma.grantorVerification.findMany({
            where: { cnic_number: cnic },
            select: { verification_id: true, grantor_number: true, is_blacklisted: true, name: true },
        });
        grantorMatches.forEach(gm => {
            if (!verificationRoleMap.has(gm.verification_id)) {
                setRole(
                    gm.verification_id,
                    `Guarantor ${gm.grantor_number || ''}`.trim(),
                    gm.is_blacklisted
                );
            }
        });
    }

    if (phone) {
        const purchaserPhoneMatches = await prisma.purchaserVerification.findMany({
            where: { telephone_number: phone },
            select: { verification_id: true, is_blacklisted: true },
        });
        purchaserPhoneMatches.forEach(pm => {
            setRole(pm.verification_id, 'Purchaser', pm.is_blacklisted);
        });

        const grantorPhoneMatches = await prisma.grantorVerification.findMany({
            where: { telephone_number: phone },
            select: { verification_id: true, grantor_number: true, is_blacklisted: true },
        });
        grantorPhoneMatches.forEach(gm => {
            if (!verificationRoleMap.has(gm.verification_id)) {
                setRole(
                    gm.verification_id,
                    `Guarantor ${gm.grantor_number || ''}`.trim(),
                    gm.is_blacklisted
                );
            }
        });

        const directOrders = await prisma.order.findMany({
            where: { whatsapp_number: phone },
            select: { id: true, verification: { select: { id: true } } },
        });
        directOrders.forEach(o => {
            if (o.verification?.id && !verificationRoleMap.has(o.verification.id)) {
                setRole(o.verification.id, 'Order Contact', false);
            }
        });
    }

    return verificationRoleMap;
};

const fetchVerificationsWithOrders = async (verificationIds) => {
    return prisma.verification.findMany({
            where: { id: { in: verificationIds } },
            include: {
                order: {
                    include: {
                        delivery: {
                            include: {
                                installment_ledger: true,
                                uploads: true
                            }
                        },
                        installment_ledger: true,
                        recovery_visits: {
                            include: {
                                photos: true,
                                officer: {
                                    select: {
                                        id: true,
                                        full_name: true,
                                        username: true
                                    }
                                }
                            },
                            orderBy: { visit_time: 'desc' }
                        },
                        statusHistories: {
                            include: {
                                user: {
                                    select: { id: true, full_name: true, username: true }
                                }
                            },
                            orderBy: { created_at: 'asc' }
                        },
                        outlet: {
                            select: { id: true, name: true, code: true }
                        },
                        assigned_to: {
                            select: { id: true, full_name: true, username: true }
                        },
                        created_by: {
                            select: { id: true, full_name: true, username: true }
                        }
                    }
                },
                purchaser: true,
                grantors: true,
                documents: {
                    orderBy: { uploaded_at: 'desc' }
                },
                verification_locations: {
                    include: { photos: true }
                },
                reviews: {
                    include: {
                        reviewer: {
                            select: { id: true, full_name: true, username: true }
                        }
                    },
                    orderBy: { created_at: 'desc' }
                },
                nextOfKin: true,
                verification_officer: {
                    select: { id: true, full_name: true, username: true }
                }
            }
        });
};

const shapeOrderHistoryResponse = (verifications, verificationRoleMap) => {
        const orders = verifications.map(verification => {
            const order = verification.order;
            const roleInfo = verificationRoleMap.get(verification.id);

            // Ledger normalization
            const ledgerModel = order.installment_ledger || order.delivery?.installment_ledger;
            const normalized = getNormalizedLedger(ledgerModel?.ledger_rows);
            const { advance_payment, installment_ledger: installmentRows, summary } = normalized;

            // Delivery plan
            let selectedPlan = order.delivery?.selected_plan || null;
            if (typeof selectedPlan === 'string') {
                try { selectedPlan = JSON.parse(selectedPlan); } catch { selectedPlan = null; }
            }

            return {
                // ── Role of this CNIC in this order ──
                cnic_role: roleInfo?.role || 'Unknown',
                is_blacklisted: roleInfo?.is_blacklisted || false,

                // ── Order core ──
                order: {
                    id: order.id,
                    order_ref: order.order_ref,
                    token_number: order.token_number,
                    status: order.status,
                    channel: order.channel,
                    customer_name: order.customer_name,
                    whatsapp_number: order.whatsapp_number,
                    alternate_contact: order.alternate_contact,
                    address: order.address,
                    city: order.city,
                    area: order.area,
                    zone: order.zone,
                    block: order.block,
                    house_no: order.house_no,
                    street: order.street,
                    product_name: order.product_name,
                    imei_serial: order.imei_serial,
                    total_amount: order.total_amount,
                    advance_amount: order.advance_amount,
                    monthly_amount: order.monthly_amount,
                    months: order.months,
                    gender: order.gender,
                    marital_status: order.marital_status,
                    residential_type: order.residential_type,
                    is_delivered: order.is_delivered,
                    order_notes: order.order_notes,
                    cancelled_at: order.cancelled_at,
                    cancelled_reason: order.cancelled_reason,
                    created_at: order.created_at,
                    updated_at: order.updated_at,
                    outlet: order.outlet,
                    created_by: order.created_by,
                    assigned_to: order.assigned_to,
                    status_histories: order.statusHistories
                },

                // ── Verification ──
                verification: {
                    id: verification.id,
                    status: verification.status,
                    start_time: verification.start_time,
                    end_time: verification.end_time,
                    verification_feedback: verification.verification_feedback,
                    home_location_required: verification.home_location_required,
                    home_location_verified: verification.home_location_verified,
                    verification_officer: verification.verification_officer,
                    purchaser: verification.purchaser,
                    grantors: verification.grantors,
                    next_of_kin: verification.nextOfKin,
                    documents: verification.documents,
                    locations: verification.verification_locations,
                    reviews: verification.reviews
                },

                // ── Delivery ──
                delivery: order.delivery ? {
                    id: order.delivery.id,
                    status: order.delivery.status,
                    self_pickup: order.delivery.self_pickup,
                    product_imei: order.delivery.product_imei,
                    selected_plan: selectedPlan,
                    start_time: order.delivery.start_time,
                    end_time: order.delivery.end_time,
                    feedback: order.delivery.feedback,
                    verified: order.delivery.verified,
                    uploads: order.delivery.uploads,
                    created_at: order.delivery.created_at
                } : null,

                // ── Installment Ledger ──
                installment_ledger: ledgerModel ? {
                    id: ledgerModel.id,
                    short_id: ledgerModel.short_id || null,
                    token: ledgerModel.token || null,
                    created_at: ledgerModel.created_at,
                    updated_at: ledgerModel.updated_at,
                    advance_payment,
                    installment_rows: installmentRows,
                    summary
                } : null,

                // ── Recovery / Visit History ──
                recovery_visits: order.recovery_visits.map(visit => ({
                    id: visit.id,
                    visit_time: visit.visit_time,
                    latitude: visit.latitude,
                    longitude: visit.longitude,
                    customer_feedback: visit.customer_feedback,
                    visit_notes: visit.visit_notes,
                    payment_collected: visit.payment_collected,
                    amount_collected: visit.amount_collected,
                    fuel_charges: visit.fuel_charges,
                    photos: visit.photos,
                    officer: visit.officer
                }))
            };
        });

        orders.sort((a, b) => new Date(b.order.created_at) - new Date(a.order.created_at));
        return orders;
};

const getPersonOrderHistory = async (req, res) => {
    const { cnic, phone } = req.query;
    const normalizedCnic = cnic?.trim() || null;
    const normalizedPhone = phone?.trim()?.replace(/\s+/g, '') || null;

    if (!normalizedCnic && !normalizedPhone) {
        return res.status(400).json({
            success: false,
            message: 'cnic or phone query parameter is required',
        });
    }

    try {
        const verificationRoleMap = await buildVerificationRoleMap({
            cnic: normalizedCnic,
            phone: normalizedPhone,
        });

        if (verificationRoleMap.size === 0) {
            return res.json({
                success: true,
                cnic: normalizedCnic,
                phone: normalizedPhone,
                total: 0,
                orders: [],
            });
        }

        const verificationIds = Array.from(verificationRoleMap.keys());
        const verifications = await fetchVerificationsWithOrders(verificationIds);
        const orders = shapeOrderHistoryResponse(verifications, verificationRoleMap);

        return res.json({
            success: true,
            cnic: normalizedCnic,
            phone: normalizedPhone,
            total: orders.length,
            orders,
        });
    } catch (error) {
        console.error('getPersonOrderHistory Error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getCNICOrderHistory = async (req, res) => {
    if (!req.query.cnic?.trim()) {
        return res.status(400).json({ success: false, message: 'cnic query parameter is required' });
    }
    return getPersonOrderHistory(req, res);
};

module.exports = {
    globalSearch,
    checkCNICOrders,
    checkPhoneOrders,
    getCNICOrderHistory,
    getPersonOrderHistory,
};
