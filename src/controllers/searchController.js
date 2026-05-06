const prisma = require('../../lib/prisma');

const globalSearch = async (req, res) => {
    const { query } = req.query;
    if (!query || query.length < 3) {
        return res.json({ success: true, results: [] });
    }

    try {
        // Base search in Orders (Phone, Ref, Token, IMEI, Name, Address)
        const orders = await prisma.order.findMany({
            where: {
                AND: [
                    { status: 'delivered' },
                    {
                        OR: [
                            { order_ref: { contains: query } },
                            { token_number: { contains: query } },
                            { customer_name: { contains: query } },
                            { whatsapp_number: { contains: query } },
                            { imei_serial: { contains: query } },
                            { address: { contains: query } },
                            // Search in Purchaser Verification details
                            { verification: { purchaser: { name: { contains: query } } } },
                            { verification: { purchaser: { cnic_number: { contains: query } } } },
                            { verification: { purchaser: { telephone_number: { contains: query } } } },
                            // Search in Delivery details
                            { delivery: { product_imei: { contains: query } } },
                        ]
                    }
                ]
            },
            include: {
                verification: {
                    include: {
                        purchaser: true,
                        grantors: true,
                        documents: true
                    }
                },
                delivery: true,
                installment_ledger: true
            },
            take: 15
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
                                verification: { include: { purchaser: true, grantors: true, documents: true } }
                            }
                        }
                    }
                }
            },
            take: 10
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
                                verification: { include: { purchaser: true, grantors: true, documents: true } }
                            }
                        }
                    }
                }
            },
            take: 10
        });

        // Consolidate unique orders
        const orderResults = new Map();

        orders.forEach(o => orderResults.set(o.id, o));
        
        purchaserMatches.forEach(pm => {
            const order = pm.verification?.order;
            if (order && order.status === 'delivered') {
                orderResults.set(order.id, order);
            }
        });

        grantorMatches.forEach(gm => {
            const order = gm.verification?.order;
            if (order && order.status === 'delivered') {
                orderResults.set(order.id, order);
            }
        });

        const results = Array.from(orderResults.values()).map(order => {
            const purchaser = order.verification?.purchaser;
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
                // Minimal verification data for profile view
                verification: order.verification ? {
                    cnic: purchaser?.cnic_number,
                    purchaser: purchaser,
                    grantors: order.verification.grantors,
                    documents: order.verification.documents
                } : null
            };
        });

        res.json({ success: true, results });
    } catch (error) {
        console.error('Global Search Error:', error);
        res.status(500).json({ success: false, message: 'Search failed' });
    }
};

module.exports = { globalSearch };
