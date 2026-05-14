const prisma = require('../../lib/prisma');
const { notifyUser, notifyAdmins, notifyOutlet } = require('../utils/notificationUtils');
const { sendOTP } = require('../services/watiService');
const { logAction } = require('../utils/auditLogger');
const axios = require('axios');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

// ─── Stock Transfer OTP Notification Helper ──────────────────────────────────

async function sendStockTransferOTPNotification(user, otp, recipientType, io = null) {
  const title = 'Stock Transfer OTP';
  const message = `Your Stock Transfer OTP is: ${otp}`;
  const notificationType = 'stock_transfer_otp';
  
  if (user?.id) {
    await notifyUser(user.id, title, message, notificationType, null, io);
  }

  if (!user?.fcm_token) return;

  try {
    await admin.messaging().send({
      token: user.fcm_token,
      notification: { title, body: message },
      data: {
        type: notificationType,
        otp: otp,
        recipient_type: recipientType,
      },
    });
  } catch (fcmError) {
    console.error('FCM send failed for transfer OTP:', fcmError);
  }
}


function roundUpToNearest50(amount) {
    return Math.ceil(amount / 50) * 50;
}

function generateInstallments(categoryName, price) {
    const category = categoryName.toLowerCase().trim();
    let plans = [];

    if (category === 'mobiles' && price <= 50000) {
        plans = [
            { months: 3, profit: 0.20, advance: 0.35 },
            { months: 6, profit: 0.35, advance: 0.25 },
            { months: 9, profit: 0.45, advance: 0.20 },
            { months: 12, profit: 0.55, advance: 0.15 },
        ];
    }
    else if (price > 50000 && price <= 100000) {
        plans = [
            { months: 3, profit: 0.20, advance: 0.40 },
            { months: 6, profit: 0.35, advance: 0.35 },
            { months: 9, profit: 0.45, advance: 0.30 },
            { months: 12, profit: 0.55, advance: 0.25 },
        ];
    }
    else if (price > 100000) {
        plans = [
            { months: 3, profit: 0.20, advance: 0.40 },
            { months: 6, profit: 0.35, advance: 0.35 },
            { months: 9, profit: 0.45, advance: 0.30 },
            { months: 12, profit: 0.55, advance: 0.25 },
            { months: 24, profit: 0.85, advance: 0.25 },
        ];
    }
    else if (price <= 50000) {
        plans = [
            { months: 3, profit: 0.22, advance: 0.40 },
            { months: 6, profit: 0.38, advance: 0.35 },
            { months: 9, profit: 0.48, advance: 0.30 },
            { months: 12, profit: 0.60, advance: 0.25 },
        ];
    } else {
        return [];
    }

    return plans.map(plan => {
        const advanceAmount = roundUpToNearest50(price * plan.advance);
        const remaining = price - advanceAmount;
        const profitAmount = roundUpToNearest50(remaining * plan.profit);
        const totalDealAmount = remaining + profitAmount;
        const monthlyAmount = roundUpToNearest50(totalDealAmount / plan.months);
        const totalPrice = advanceAmount + (monthlyAmount * plan.months);

        return {
            advance: advanceAmount,
            totalPrice: totalPrice,
            monthlyAmount: monthlyAmount,
            months: plan.months,
            isActive: true,
        };
    });
}

const getInventory = async (req, res) => {
    const { outlet_id } = req.user;
    const { page = 1, limit = 20, search = "" } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    try {
        // 1. Get unique product names that match search criteria
        const productSearchWhere = {
            outlet_id,
            OR: search ? [
                { product_name: { contains: search } },
                { imei_serial: { contains: search } },
                { category: { contains: search } }
            ] : undefined
        };

        // Get distinct product names for pagination
        const distinctProducts = await prisma.outletInventory.findMany({
            where: productSearchWhere,
            distinct: ['product_name'],
            select: { product_name: true },
            orderBy: { product_name: 'asc' },
            skip,
            take
        });

        const totalProductsCount = await prisma.outletInventory.groupBy({
            by: ['product_name'],
            where: productSearchWhere,
            _count: true
        });
        const total = totalProductsCount.length;

        const productNames = distinctProducts.map(p => p.product_name);

        // 2. Fetch all records for these product names
        const inventory = await prisma.outletInventory.findMany({
            where: {
                outlet_id,
                product_name: { in: productNames }
            },
            orderBy: [{ product_name: 'asc' }, { id: 'asc' }]
        });

        // 3. Calculate Global Stats (Count unique product names)
        const [totalUniqueProducts, inStockUnique, soldUnique] = await Promise.all([
            prisma.outletInventory.groupBy({
                by: ['product_name'],
                where: { outlet_id },
                _count: true
            }),
            prisma.outletInventory.groupBy({
                by: ['product_name'],
                where: { outlet_id, status: 'In Stock' },
                _count: true
            }),
            prisma.outletInventory.groupBy({
                by: ['product_name'],
                where: { outlet_id, status: 'Sold' },
                _count: true
            })
        ]);

        res.json({ 
            success: true, 
            inventory, // Frontend will group these by product_name
            stats: {
                totalStock: totalUniqueProducts.length || 0,
                inStock: inStockUnique.length || 0,
                sold: soldUnique.length || 0
            },
            pagination: {
                total, // total unique products
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('getInventory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const addInventory = async (req, res) => {
    const { outlet_id } = req.user;
    const { items } = req.body;

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'No items provided.' });
    }

    try {
        const createdItems = [];
        for (const item of items) {
            const { product_name, category, imei_serial, purchase_price, status, color_variant, quantity, installment_plans } = item;

            if (!product_name || purchase_price === undefined) {
                continue;
            }

            const purchasePriceNum = parseFloat(purchase_price);
            
            // Check for duplicate IMEI system-wide
            if (imei_serial && imei_serial.trim() !== '') {
                const duplicate = await prisma.outletInventory.findFirst({
                    where: { imei_serial: imei_serial.trim() }
                });
                if (duplicate) {
                    return res.status(400).json({ 
                        success: false, 
                        message: `IMEI/Serial ${imei_serial} already exists.` 
                    });
                }
            }

            // If installment_plans are provided in the request (from external API), use them.
            // Otherwise, generate new ones.
            const instPlans = (installment_plans && Array.isArray(installment_plans)) 
                ? installment_plans 
                : generateInstallments(category || '', purchasePriceNum);

            const created = await prisma.outletInventory.create({
                data: {
                    outlet_id,
                    product_name,
                    category: category || '',
                    imei_serial: imei_serial || null,
                    color_variant: color_variant || null,
                    quantity: parseInt(quantity) || 1,
                    purchase_price: purchasePriceNum,
                    installment_price: 0, 
                    installment_plans: instPlans,
                    status: status || 'In Stock'
                }
            });
            createdItems.push(created);
        }

        if (createdItems.length > 0) {
            await logAction(
                req, 
                'STOCK_ADDITION', 
                `Added ${createdItems.length} items to inventory. (First item: ${createdItems[0].product_name})`,
                createdItems[0].id,
                'Inventory'
            );
        }

        res.status(201).json({ success: true, count: createdItems.length, items: createdItems });
    } catch (error) {
        console.error('addInventory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const initiateStockTransfer = async (req, res) => {
    const { outlet_id } = req.user;
    const { inventory_ids, to_id, to_type } = req.body; // to_type: 'Delivery Officer' | 'Outlet'

    if (!outlet_id || !inventory_ids || !Array.isArray(inventory_ids) || inventory_ids.length === 0 || !to_id || !to_type) {
        return res.status(400).json({ success: false, message: 'Missing fields.' });
    }

    const targetId = parseInt(to_id);

    try {
        let recipientIdentifier = '';
        let recipientPhone = '';
        let recipientName = '';
        let doUser = null;
        let targetOutlet = null;

        if (to_type === 'Outlet') {
            targetOutlet = await prisma.outlet.findUnique({ where: { id: targetId } });
            if (!targetOutlet) return res.status(404).json({ success: false, message: 'Target outlet not found.' });
            if (targetOutlet.id === outlet_id) return res.status(400).json({ success: false, message: 'Cannot transfer to same outlet.' });
            recipientIdentifier = `outlet_${targetId}`;
            recipientName = targetOutlet.name;
            // Assuming outlets have a contact phone or we use a manager's phone. 
            // For now, let's look for any user in that outlet to get a phone number for WATI if needed.
            const outletManager = await prisma.user.findFirst({ where: { outlet_id: targetId, role_id: 4 } }); // Role 4 = Outlet Manager?
            recipientPhone = outletManager?.phone || outletManager?.whatsapp_number || '';
        } else if (to_type === 'Delivery Officer') {
            doUser = await prisma.user.findFirst({ where: { id: targetId, role_id: 2 } });
            if (!doUser) return res.status(404).json({ success: false, message: 'Delivery officer not found.' });
            recipientIdentifier = `do_${targetId}`;
            recipientName = doUser.full_name;
            recipientPhone = doUser.phone || doUser.whatsapp_number;
        } else {
            return res.status(400).json({ success: false, message: 'Invalid transfer type.' });
        }

        // Normalize inventory IDs
        const rawIds = inventory_ids.map(i => typeof i === 'object' ? parseInt(i.id) : parseInt(i));

        // Fetch items and mark as Pending Transfer
        const items = await prisma.outletInventory.findMany({
            where: { id: { in: rawIds }, outlet_id, status: 'In Stock' }
        });

        if (items.length !== rawIds.length) {
            return res.status(400).json({ success: false, message: 'Some items could not be found or are not in stock.' });
        }

        const otp = Math.floor(10000 + Math.random() * 90000).toString();

        const result = await prisma.$transaction(async (tx) => {
            // 1. Create OTP
            await tx.otp.create({
                data: {
                    phone: recipientIdentifier,
                    otp,
                    purpose: 'stock_transfer',
                    expiresAt: new Date(Date.now() + 15 * 60000)
                }
            });

            const transferRecordsToCreate = [];

            // 2. Process each item (with row splitting if needed)
            for (const payloadItem of inventory_ids) {
                const recordId = typeof payloadItem === 'object' ? parseInt(payloadItem.id) : parseInt(payloadItem);
                const requestedQty = typeof payloadItem === 'object' ? (parseInt(payloadItem.quantity) || 1) : 1;

                const item = await tx.outletInventory.findUnique({
                    where: { id: recordId, outlet_id, status: 'In Stock' }
                });

                if (!item || item.quantity < requestedQty) {
                    throw new Error(`Item ${recordId} not found or insufficient quantity.`);
                }

                let finalInventoryId = item.id;

                if (requestedQty < item.quantity) {
                    // SPLIT ROW: Create a new row for the pending transfer
                    const newPendingRow = await tx.outletInventory.create({
                        data: {
                            outlet_id: item.outlet_id,
                            product_name: item.product_name,
                            category: item.category,
                            imei_serial: item.imei_serial,
                            purchase_price: item.purchase_price,
                            installment_price: item.installment_price,
                            status: 'Pending Transfer',
                            color_variant: item.color_variant,
                            quantity: requestedQty,
                            installment_plans: item.installment_plans
                        }
                    });

                    // Update original row (reduce quantity)
                    await tx.outletInventory.update({
                        where: { id: item.id },
                        data: { quantity: item.quantity - requestedQty }
                    });

                    finalInventoryId = newPendingRow.id;
                } else {
                    // FULL ROW: Just mark as Pending Transfer
                    await tx.outletInventory.update({
                        where: { id: item.id },
                        data: { status: 'Pending Transfer' }
                    });
                }

                transferRecordsToCreate.push({
                    from_type: 'Outlet',
                    from_id: outlet_id,
                    to_type,
                    to_id: targetId,
                    inventory_id: finalInventoryId,
                    quantity_transferred: requestedQty,
                    status: 'pending'
                });
            }

            // 3. Create StockTransfer records
            await tx.stockTransfer.createMany({ data: transferRecordsToCreate });

            return { otp };
        });

        // Notifications & Sockets
        const io = req.app.get('io');
        const message = `Stock Transfer OTP: ${otp}. From Outlet ${outlet_id} to ${to_type} ${recipientName}`;
        
        // Log OTP
        await prisma.otpLog.create({
            data: {
                user_id: to_type === 'Delivery Officer' ? parseInt(targetId) : req.user.id,
                action: "stock_transfer_otp",
                message,
                otp
            }
        });

        if (io) {
            // Notify Receiver
            const receiverRoom = to_type === 'Delivery Officer' ? `user_${targetId}` : `outlet_${targetId}`;
            io.to(receiverRoom).emit('stock_transfer_initiated', {
                from_id: outlet_id,
                from_name: req.user.outlet_name || `Outlet ${outlet_id}`,
                items_count: items.length,
                items: items.map(i => ({ name: i.product_name, imei: i.imei_serial })),
                otp: otp, // Sending OTP via socket for the popup
                to_type
            });

            // Notify Sender
            const senderRoom = `outlet_${outlet_id}`;
            io.to(senderRoom).emit('stock_transfer_status', {
                status: 'initiated',
                to_name: recipientName,
                items_count: rawIds.length
            });

            // Specific event for Mobile App (Delivery Officer)
            if (to_type === 'Delivery Officer') {
                const appRoom = `user_${targetId}`;
                io.to(appRoom).emit('stock_transfer_otp', {
                    action: "stock_transfer_otp",
                    message,
                    otp,
                    created_at: new Date()
                });
            }
        }

        // Send OTP via external services if available
        if (recipientPhone) {
            await sendOTP(recipientPhone, otp).catch(e => console.error('OTP Service Error:', e));
        }

        // Send FCM Notification for Mobile App (pass null for io to avoid duplicate socket event)
        const recipientUser = to_type === 'Delivery Officer' ? doUser : 
            await prisma.user.findFirst({ where: { outlet_id: targetId, role_id: 4 } });
        
        if (recipientUser) {
            await sendStockTransferOTPNotification(recipientUser, otp, to_type, null).catch(e => console.error('FCM Notification Error:', e));
        }

        const itemsDetail = items.map(i => `${i.product_name} (${i.imei_serial || 'No IMEI'})`).join(', ');
        await logAction(req, 'STOCK_TRANSFER_INITIATED', `Initiated transfer of items to ${to_type} ${recipientName}: ${itemsDetail}`, null, 'Inventory');

        res.json({ success: true, message: `OTP sent successfully to ${to_type}.`, otp_sent: true });
    } catch (error) {
        console.error('initiateStockTransfer error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};


const verifyStockTransfer = async (req, res) => {
    const { outlet_id, outlet_name } = req.user;
    const { otp, inventory_ids, to_id, to_type } = req.body;

    if (!outlet_id || !otp || !inventory_ids || !Array.isArray(inventory_ids) || !to_id || !to_type) {
        return res.status(400).json({ success: false, message: 'Missing fields.' });
    }

    try {
        const targetId = parseInt(to_id);
        const phoneKey = to_type === 'Outlet' ? `outlet_${targetId}` : `do_${targetId}`;

        const otpRecord = await prisma.otp.findFirst({
            where: { phone: phoneKey, purpose: 'stock_transfer', isUsed: false },
            orderBy: { createdAt: 'desc' }
        });

        if (!otpRecord || otpRecord.otp !== otp || otpRecord.expiresAt < new Date()) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
        }

        // Normalize inventory IDs
        const rawIds = inventory_ids.map(i => typeof i === 'object' ? i.id : i);

        // Fetch items that are in 'Pending Transfer' status at the origin outlet
        const items = await prisma.outletInventory.findMany({
            where: { id: { in: rawIds }, outlet_id, status: 'Pending Transfer' }
        });

        if (items.length !== rawIds.length) {
            return res.status(400).json({ success: false, message: 'Some items could not be found or are not in pending transfer status.' });
        }

        // Process transfers
        const transfers = await prisma.$transaction(async (tx) => {
            const transferData = [];
            
            for (const payloadItem of inventory_ids) {
                const recordId = typeof payloadItem === 'object' ? payloadItem.id : payloadItem;
                const transferQty = typeof payloadItem === 'object' ? (parseInt(payloadItem.quantity) || 1) : 1;

                const item = items.find(i => i.id === recordId);
                if (!item) continue;

                let isFullTransfer = (item.quantity <= transferQty);
                let actualTransferQty = isFullTransfer ? item.quantity : transferQty;

                if (to_type === 'Outlet') {
                    if (isFullTransfer) {
                        // Full row moves to target outlet
                        await tx.outletInventory.update({
                            where: { id: item.id },
                            data: { outlet_id: targetId, status: 'In Stock' }
                        });
                    } else {
                        // Split row: Original stays at origin with reduced Qty, new row created at target
                        await tx.outletInventory.update({
                            where: { id: item.id },
                            data: { quantity: item.quantity - actualTransferQty, status: 'In Stock' }
                        });

                        const existingAtTarget = await tx.outletInventory.findFirst({
                            where: { outlet_id: targetId, product_name: item.product_name, status: 'In Stock' }
                        });

                        if (existingAtTarget) {
                            await tx.outletInventory.update({
                                where: { id: existingAtTarget.id },
                                data: { quantity: existingAtTarget.quantity + actualTransferQty }
                            });
                        } else {
                            await tx.outletInventory.create({
                                data: {
                                    outlet_id: targetId,
                                    product_name: item.product_name,
                                    category: item.category,
                                    imei_serial: item.imei_serial || null,
                                    color_variant: item.color_variant || null,
                                    quantity: actualTransferQty,
                                    purchase_price: item.purchase_price,
                                    installment_price: item.installment_price,
                                    status: 'In Stock'
                                }
                            });
                        }
                    }
                } else {
                    // Delivery Officer: Row stays at origin but marked 'Out Of Stock' or stays 'Pending'?
                    // Actually for DO, it stays 'Out Of Stock' as it leaves the outlet.
                    if (isFullTransfer) {
                        await tx.outletInventory.update({
                            where: { id: item.id },
                            data: { status: 'Out Of Stock' }
                        });
                    } else {
                        await tx.outletInventory.update({
                            where: { id: item.id },
                            data: { quantity: item.quantity - actualTransferQty, status: 'In Stock' }
                        });
                        // We might need to create a record of what the DO is carrying, but currently DO inventory isn't explicitly tracked in rows.
                        // It's tracked via StockTransfer and Order status.
                    }
                }

                // Update StockTransfer record status to 'delivered'
                await tx.stockTransfer.updateMany({
                    where: { 
                        inventory_id: item.id, 
                        from_id: outlet_id, 
                        to_id: targetId, 
                        status: 'pending' 
                    },
                    data: { status: 'transferred' }
                });

                transferData.push({ id: item.id, qty: actualTransferQty });
            }

            // Mark OTP as used
            await tx.otp.update({
                where: { id: otpRecord.id },
                data: { isUsed: true }
            });

            return transferData; 
        }, { timeout: 15000 }); 

        // Notifications
        const io = req.app.get('io');
        const messageTitle = 'Stock Transfer Completed';
        const messageBody = `Transfer of ${transfers.length} item batch(es) from Outlet ${outlet_id} to ${to_type} ${targetId} has been verified.`;

        if (io) {
            const receiverRoom = to_type === 'Delivery Officer' ? `user_${targetId}` : `outlet_${targetId}`;
            const senderRoom = `outlet_${outlet_id}`;
            
            io.to(receiverRoom).emit('stock_transfer_completed', { 
                message: 'Stock transferred successfully. Your inventory has been updated.', 
                from_id: outlet_id 
            });
            io.to(senderRoom).emit('stock_transfer_status', { status: 'completed', to_id: targetId, to_type });
        }

        const itemsDetail = items.map(i => `${i.product_name} (${i.imei_serial || 'No IMEI'})`).join(', ');
        await logAction(req, 'STOCK_TRANSFER_VERIFIED', `Verified transfer of items to ${to_type} ${targetId}: ${itemsDetail}`, null, 'Inventory');

        res.json({ success: true, transfers });
    } catch (error) {
        console.error('verifyStockTransfer error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};


const getTransferHistory = async (req, res) => {
    const { outlet_id } = req.user;
    const { page = 1, limit = 20, search = "", to_type, startDate, endDate, direction = 'sent', status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    try {
        const where = { 
            from_type: direction === 'sent' ? 'Outlet' : undefined, 
            from_id: direction === 'sent' ? outlet_id : undefined,
            to_type: direction === 'received' ? 'Outlet' : (to_type || undefined),
            to_id: direction === 'received' ? outlet_id : undefined,
            status: status || undefined,
            created_at: (startDate || endDate) ? {
                gte: startDate ? new Date(startDate) : undefined,
                lte: endDate ? new Date(endDate) : undefined
            } : undefined,
            OR: search ? [
                { inventory: { product_name: { contains: search } } },
                { inventory: { imei_serial: { contains: search } } }
            ] : undefined
        };

        const [transfers, total] = await Promise.all([
            prisma.stockTransfer.findMany({
                where,
                include: {
                    inventory: {
                        select: {
                            id: true,
                            product_name: true,
                            category: true,
                            color_variant: true,
                            imei_serial: true,
                            quantity: true,
                            purchase_price: true,
                            status: true
                        }
                    }
                },
                orderBy: { created_at: 'desc' },
                skip,
                take
            }),
            prisma.stockTransfer.count({ where })
        ]);

        // Map IDs to human readable names
        const deliveryToIds = [...new Set(transfers.filter(t => t.to_type === 'Delivery Officer').map(t => t.to_id))];
        const outletToIds = [...new Set(transfers.filter(t => t.to_type === 'Outlet').map(t => t.to_id))];
        const outletFromIds = [...new Set(transfers.filter(t => t.from_type === 'Outlet').map(t => t.from_id))];

        const [deliveryOfficers, targetOutlets, sourceOutlets] = await Promise.all([
            prisma.user.findMany({
                where: { id: { in: deliveryToIds } },
                select: { id: true, full_name: true, username: true }
            }),
            prisma.outlet.findMany({
                where: { id: { in: outletToIds } },
                select: { id: true, name: true, address: true }
            }),
            prisma.outlet.findMany({
                where: { id: { in: outletFromIds } },
                select: { id: true, name: true, address: true }
            })
        ]);

        const mappedTransfers = transfers.map(t => {
            let recipientName = 'Unknown';
            let senderName = 'Unknown';

            if (t.to_type === 'Delivery Officer') {
                const off = deliveryOfficers.find(o => o.id === t.to_id);
                if (off) recipientName = `${off.full_name} (${off.username})`;
            } else if (t.to_type === 'Outlet') {
                const out = targetOutlets.find(o => o.id === t.to_id);
                if (out) recipientName = `${out.name} (${out.address || 'No Address'})`;
            }

            if (t.from_type === 'Outlet') {
                const out = sourceOutlets.find(o => o.id === t.from_id);
                if (out) senderName = out.name;
            }

            return {
                ...t,
                recipient_name: recipientName,
                sender_name: senderName
            };
        });

        res.json({ 
            success: true, 
            count: mappedTransfers.length, 
            transfers: mappedTransfers,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('getTransferHistory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};


const updateInventoryItem = async (req, res) => {
    const { outlet_id } = req.user;
    const { id } = req.params;
    const data = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Unauthorized' });

    try {
        const updated = await prisma.outletInventory.updateMany({
            where: { id: parseInt(id), outlet_id },
            data: {
                product_name: data.product_name,
                category: data.category,
                imei_serial: data.imei_serial,
                color_variant: data.color_variant,
                quantity: data.quantity !== undefined ? parseInt(data.quantity) : undefined,
                purchase_price: data.purchase_price !== undefined ? parseFloat(data.purchase_price) : undefined,
                status: data.status,
            }
        });

        if (updated.count === 0) return res.status(404).json({ success: false, message: 'Item not found' });
        
        res.json({ success: true, message: 'Item updated successfully' });
    } catch (error) {
        console.error('Update item err:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const deleteInventoryItem = async (req, res) => {
    const { outlet_id } = req.user;
    const { id } = req.params;

    try {
        const deleted = await prisma.outletInventory.deleteMany({
            where: { id: parseInt(id), outlet_id }
        });

        if (deleted.count === 0) return res.status(404).json({ success: false, message: 'Item not found' });
        
        res.json({ success: true, message: 'Item deleted successfully' });
    } catch (error) {
        console.error('Delete item err:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const bulkUpdateInventory = async (req, res) => {
    const { outlet_id } = req.user;
    const { ids, data } = req.body;

    if (!outlet_id || !Array.isArray(ids) || ids.length === 0 || !data) {
        return res.status(400).json({ success: false, message: 'Invalid payload' });
    }

    try {
        let updateData = {};
        if (data.status) updateData.status = data.status;
        if (data.product_name) updateData.product_name = data.product_name;
        if (data.category) updateData.category = data.category;
        if (data.color_variant) updateData.color_variant = data.color_variant;
        if (data.quantity !== undefined) updateData.quantity = parseInt(data.quantity);
        if (data.purchase_price !== undefined) updateData.purchase_price = parseFloat(data.purchase_price);

        const updated = await prisma.outletInventory.updateMany({
            where: { id: { in: ids.map(id => parseInt(id)) }, outlet_id },
            data: updateData
        });

        res.json({ success: true, count: updated.count, message: 'Items updated successfully' });
    } catch (error) {
        console.error('Bulk update err:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const bulkDeleteInventory = async (req, res) => {
    const { outlet_id } = req.user;
    const { ids } = req.body;

    if (!outlet_id || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid payload' });
    }

    try {
        const deleted = await prisma.outletInventory.deleteMany({
            where: { id: { in: ids.map(id => parseInt(id)) }, outlet_id }
        });

        res.json({ success: true, count: deleted.count, message: 'Items deleted successfully' });
    } catch (error) {
        console.error('Bulk delete err:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const cancelStockTransfer = async (req, res) => {
    const { outlet_id } = req.user;
    const { transfer_ids, reason } = req.body;

    if (!outlet_id || !transfer_ids || !Array.isArray(transfer_ids)) {
        return res.status(400).json({ success: false, message: 'Missing transfer IDs.' });
    }

    try {
        const transfers = await prisma.stockTransfer.findMany({
            where: { id: { in: transfer_ids }, from_id: outlet_id, status: 'pending' },
            include: { inventory: true }
        });

        if (transfers.length === 0) {
            return res.status(404).json({ success: false, message: 'No pending transfers found for these IDs.' });
        }

        const inventoryIds = transfers.map(t => t.inventory_id);

        await prisma.$transaction(async (tx) => {
            // 1. Update StockTransfer status
            await tx.stockTransfer.updateMany({
                where: { id: { in: transfers.map(t => t.id) } },
                data: { status: 'cancelled' }
            });

            // 2. Revert inventory status
            // Note: We process each inventory item to ensure status is reverted
            for (const t of transfers) {
                const inv = await tx.outletInventory.findUnique({ where: { id: t.inventory_id } });
                if (inv && inv.status === 'Pending Transfer') {
                    // Check if there's an existing 'In Stock' row for the same item to merge back into
                    // To keep it simple and safe, we just set the status back to 'In Stock'
                    await tx.outletInventory.update({
                        where: { id: inv.id },
                        data: { status: 'In Stock' }
                    });
                }
            }
        });

        const io = req.app.get('io');
        if (io) {
            transfers.forEach(t => {
                const receiverRoom = t.to_type === 'Delivery Officer' ? `user_${t.to_id}` : `outlet_${t.to_id}`;
                io.to(receiverRoom).emit('stock_transfer_cancelled', { transfer_id: t.id, reason });
            });
        }

        const itemsDetail = transfers.map(t => `${t.inventory?.product_name || 'Item'} (${t.inventory?.imei_serial || 'No IMEI'})`).join(', ');
        await logAction(req, 'STOCK_TRANSFER_CANCELLED', `Cancelled transfer of items: ${itemsDetail}. Reason: ${reason || 'N/A'}`, null, 'Inventory');

        res.json({ success: true, message: 'Transfers cancelled successfully.' });
    } catch (error) {
        console.error('cancelStockTransfer error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const resendStockTransferOTP = async (req, res) => {
    const { outlet_id } = req.user;
    const { to_id, to_type, transfer_ids } = req.body;

    if (!outlet_id || !to_id || !to_type) {
        return res.status(400).json({ success: false, message: 'Missing fields.' });
    }

    try {
        const targetId = parseInt(to_id);
        const recipientIdentifier = to_type === 'Outlet' ? `outlet_${targetId}` : `do_${targetId}`;
        
        // Find recipient phone
        let recipientPhone = '';
        if (to_type === 'Outlet') {
            const manager = await prisma.user.findFirst({ where: { outlet_id: targetId, role_id: 4 } });
            recipientPhone = manager?.phone || manager?.whatsapp_number || '';
        } else {
            const user = await prisma.user.findUnique({ where: { id: targetId } });
            recipientPhone = user?.phone || user?.whatsapp_number || '';
        }

        const otp = Math.floor(10000 + Math.random() * 90000).toString();

        await prisma.otp.create({
            data: {
                phone: recipientIdentifier,
                otp,
                purpose: 'stock_transfer',
                expiresAt: new Date(Date.now() + 15 * 60000)
            }
        });

        // Log OTP
        await prisma.otpLog.create({
            data: {
                user_id: to_type === 'Delivery Officer' ? parseInt(targetId) : req.user.id,
                action: "stock_transfer_otp_resend",
                message: `Stock Transfer OTP Resent: ${otp}. To ${to_type} ${targetId}`,
                otp
            }
        });

        const pendingTransfers = await prisma.stockTransfer.findMany({
            where: { 
                from_id: outlet_id, 
                to_id: targetId, 
                to_type, 
                status: 'pending',
                id: (transfer_ids && Array.isArray(transfer_ids)) ? { in: transfer_ids.map(id => parseInt(id)) } : undefined
            },
            include: { inventory: true }
        });

        // Notifications & Sockets
        const io = req.app.get('io');
        if (io) {
            const receiverRoom = to_type === 'Delivery Officer' ? `user_${targetId}` : `outlet_${targetId}`;
            io.to(receiverRoom).emit('stock_transfer_initiated', {
                from_id: outlet_id,
                from_name: req.user.outlet_name || `Outlet ${outlet_id}`,
                otp: otp,
                to_type,
                items_count: pendingTransfers.length,
                items: pendingTransfers.map(t => ({ name: t.inventory.product_name, imei: t.inventory.imei_serial })),
                is_resend: true
            });

            // Specific event for Mobile App (Resend)
            if (to_type === 'Delivery Officer') {
                const appRoom = `user_${targetId}`;
                io.to(appRoom).emit('stock_transfer_otp', {
                    action: "stock_transfer_otp_resend",
                    message: `Your Stock Transfer OTP has been resent: ${otp}`,
                    otp,
                    created_at: new Date()
                });
            }
        }

        if (recipientPhone) {
            const resendMessage = `Your Stock Transfer OTP has been resent: ${otp}. Please share this with the sender.`;
            await sendOTP(recipientPhone, otp, resendMessage).catch(e => console.error('OTP Service Error:', e));
        }

        // Send FCM Notification for Mobile App (Resend) - pass null for io to avoid duplicate socket event
        const recipientUser = to_type === 'Delivery Officer' ? 
            await prisma.user.findUnique({ where: { id: targetId } }) : 
            await prisma.user.findFirst({ where: { outlet_id: targetId, role_id: 4 } });
        
        if (recipientUser) {
            await sendStockTransferOTPNotification(recipientUser, otp, to_type, null).catch(e => console.error('FCM Resend Notification Error:', e));
        }

        res.json({ success: true, message: 'OTP resent successfully.' });
    } catch (error) {
        console.error('resendStockTransferOTP error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const requestStockTransfer = async (req, res) => {
    const { outlet_id, outlet_name } = req.user;
    const { from_id } = req.body; // Origin outlet id

    if (!outlet_id || !from_id) {
        return res.status(400).json({ success: false, message: 'Missing fields.' });
    }

    try {
        const io = req.app.get('io');
        if (io) {
            const originRoom = `outlet_${from_id}`;
            io.to(originRoom).emit('stock_transfer_request', {
                requested_by_id: outlet_id,
                requested_by_name: outlet_name || `Outlet ${outlet_id}`
            });
        }

        res.json({ success: true, message: 'Transfer request sent to origin outlet.' });
    } catch (error) {
        console.error('requestStockTransfer error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getInventory,
    addInventory,
    initiateStockTransfer,
    verifyStockTransfer,
    getTransferHistory,
    cancelStockTransfer,
    resendStockTransferOTP,
    requestStockTransfer,
    updateInventoryItem,
    deleteInventoryItem,
    bulkUpdateInventory,
    bulkDeleteInventory,
    generateInstallments
};

