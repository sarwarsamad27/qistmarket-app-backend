const prisma = require('../../lib/prisma');
const axios = require('axios');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { logAction } = require('../utils/auditLogger');
const { generateInstallments } = require('./inventoryController');

const QIST_MARKET_API = 'https://api.qistmarket.pk/api/product';

// Fetch all products from qistmarket.pk and build a lowercase name → product map
async function fetchApiProductMap() {
    try {
        const response = await axios.get(QIST_MARKET_API, { timeout: 8000 });
        const products = Array.isArray(response.data) ? response.data : [];
        const map = new Map();
        for (const p of products) {
            if (p.name) {
                map.set(p.name.trim().toLowerCase(), p);
            }
        }
        return map;
    } catch (err) {
        console.warn('fetchApiProductMap: Could not reach qistmarket API:', err.message);
        return new Map(); // Graceful fallback — use unit_price based plans
    }
}

// Convert API ProductInstallments to our installment_plans format
function mapApiInstallments(apiInstallments = []) {
    return apiInstallments
        .filter(i => i.isActive !== false)
        .map(i => ({
            advance: parseFloat(i.advance) || 0,
            totalPrice: parseFloat(i.totalPrice) || 0,
            monthlyAmount: parseFloat(i.monthlyAmount) || 0,
            months: parseInt(i.months) || 0,
            isActive: true,
        }));
}

// Helper to generate Invoice Number: PUR-YYYY-XXXX
const generateInvoiceNumber = async (tx) => {
    const year = new Date().getFullYear();
    const prefix = `PUR-${year}-`;

    const lastPurchase = await tx.vendorPurchase.findFirst({
        where: { invoice_number: { startsWith: prefix } },
        orderBy: { invoice_number: 'desc' },
        select: { invoice_number: true }
    });

    let nextNumber = 1;
    if (lastPurchase) {
        const parts = lastPurchase.invoice_number.split('-');
        if (parts.length >= 3) {
            nextNumber = parseInt(parts[2]) + 1;
        }
    }

    return `${prefix}${nextNumber.toString().padStart(4, '0')}`;
};

const generateReturnNumber = async (tx) => {
    const year = new Date().getFullYear();
    const prefix = `RET-${year}-`;

    const lastReturn = await tx.vendorPurchaseReturn.findFirst({
        where: { return_number: { startsWith: prefix } },
        orderBy: { return_number: 'desc' },
        select: { return_number: true }
    });

    let nextNumber = 1;
    if (lastReturn) {
        const parts = lastReturn.return_number.split('-');
        if (parts.length >= 3) {
            nextNumber = parseInt(parts[2]) + 1;
        }
    }

    return `${prefix}${nextNumber.toString().padStart(4, '0')}`;
};

// --- Vendor CRUD ---

const getVendors = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Unauthorized' });

    try {
        const vendors = await prisma.vendor.findMany({
            where: { outlet_id },
            orderBy: { name: 'asc' }
        });
        res.json({ success: true, vendors });
    } catch (error) {
        console.error('getVendors error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const createVendor = async (req, res) => {
    const { outlet_id } = req.user;
    const { name, phone, email, address } = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

    try {
        const vendor = await prisma.vendor.create({
            data: { outlet_id, name, phone, email, address }
        });
        res.status(201).json({ success: true, vendor });
    } catch (error) {
        console.error('createVendor error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const updateVendor = async (req, res) => {
    const { id } = req.params;
    const { name, phone, email, address } = req.body;

    try {
        const vendor = await prisma.vendor.update({
            where: { id: parseInt(id) },
            data: { name, phone, email, address }
        });
        res.json({ success: true, vendor });
    } catch (error) {
        console.error('updateVendor error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// --- Purchases ---

const createPurchase = async (req, res) => {
    const { outlet_id } = req.user;
    const { vendor_id, vendor_name, purchase_date, due_date, notes, items } = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    if (!items || !items.length) {
        return res.status(400).json({ success: false, message: 'Items are required.' });
    }

    try {
        // Fetch API product map BEFORE transaction (outside, to avoid slow HTTP inside tx)
        const apiProductMap = await fetchApiProductMap();

        const result = await prisma.$transaction(async (tx) => {
            const invoice_number = await generateInvoiceNumber(tx);

            // 1. Resolve Vendor
            let finalVendorId = vendor_id ? parseInt(vendor_id) : null;
            let finalVendorName = vendor_name;

            if (!finalVendorId && vendor_name) {
                // Try to find vendor by name for this outlet first
                let existingVendor = await tx.vendor.findFirst({
                    where: { outlet_id, name: vendor_name }
                });
                if (!existingVendor) {
                    existingVendor = await tx.vendor.create({
                        data: { outlet_id, name: vendor_name }
                    });
                }
                finalVendorId = existingVendor.id;
                finalVendorName = existingVendor.name;
            }

            let totalAmount = 0;
            const purchaseItemsData = [];
            const inventoryData = [];

            for (const item of items) {
                const qty = parseInt(item.quantity) || 1;
                const unitPrice = parseFloat(item.unit_price) || 0;
                const totalPrice = qty * unitPrice;
                totalAmount += totalPrice;

                // Check for unique IMEI/Serial if provided (System-wide check)
                if (item.imei_serial && item.imei_serial.trim() !== '') {
                    const duplicate = await tx.outletInventory.findFirst({
                        where: {
                            imei_serial: item.imei_serial.trim()
                        }
                    });
                    if (duplicate) {
                        throw new Error(`IMEI/Serial ${item.imei_serial} already exists.`);
                    }
                }

                purchaseItemsData.push({
                    product_name: item.product_name,
                    category: item.category,
                    color_variant: item.color_variant,
                    imei_serial: item.imei_serial ? item.imei_serial.trim() : null,
                    quantity: qty,
                    unit_price: unitPrice,
                    total_price: totalPrice
                });

                // Resolve installments & sale price from API or fallback to unit_price
                const apiProduct = apiProductMap.get((item.product_name || '').trim().toLowerCase());
                let resolvedPlans;
                let resolvedSalePrice = null;
                let resolvedApiProductName = null;

                if (apiProduct && apiProduct.ProductInstallments && apiProduct.ProductInstallments.length > 0) {
                    resolvedPlans = mapApiInstallments(apiProduct.ProductInstallments);
                    resolvedSalePrice = parseFloat(apiProduct.price) || null;
                    resolvedApiProductName = apiProduct.name;
                } else {
                    resolvedPlans = generateInstallments(item.category || '', unitPrice);
                }

                // Add or update inventory
                const existingItem = await tx.outletInventory.findFirst({
                    where: {
                        outlet_id,
                        product_name: item.product_name,
                        imei_serial: item.imei_serial ? item.imei_serial.trim() : null,
                        color_variant: item.color_variant || null
                    }
                });

                if (existingItem) {
                    await tx.outletInventory.update({
                        where: { id: existingItem.id },
                        data: {
                            quantity: existingItem.quantity + qty,
                            purchase_price: unitPrice,
                            status: 'In Stock',
                            category: item.category || existingItem.category,
                            color_variant: item.color_variant || existingItem.color_variant,
                            installment_plans: resolvedPlans,
                            sale_price: resolvedSalePrice,
                            api_product_name: resolvedApiProductName
                        }
                    });
                } else {
                    await tx.outletInventory.create({
                        data: {
                            outlet_id,
                            product_name: item.product_name,
                            category: item.category,
                            color_variant: item.color_variant,
                            imei_serial: item.imei_serial ? item.imei_serial.trim() : null,
                            quantity: qty,
                            purchase_price: unitPrice,
                            installment_price: 0,
                            installment_plans: resolvedPlans,
                            sale_price: resolvedSalePrice,
                            api_product_name: resolvedApiProductName,
                            status: 'In Stock'
                        }
                    });
                }
            }

            const purchase = await tx.vendorPurchase.create({
                data: {
                    outlet_id,
                    vendor_id: finalVendorId,
                    invoice_number,
                    vendor_name: finalVendorName,
                    notes,
                    total_amount: totalAmount,
                    balance: totalAmount,
                    status: 'Unpaid',
                    due_date: due_date ? new Date(due_date) : null,
                    purchase_date: purchase_date ? new Date(purchase_date) : new Date(),
                    items: {
                        create: purchaseItemsData
                    }
                },
                include: { items: true }
            });

            // Update Vendor Balance
            if (finalVendorId) {
                await tx.vendor.update({
                    where: { id: finalVendorId },
                    data: { balance: { increment: totalAmount } }
                });
            }

            return purchase;
        }, {
            maxWait: 5000,
            timeout: 15000
        });

        await logAction(
            req,
            'VENDOR_PURCHASE',
            `Recorded purchase ${result.invoice_number} from ${result.vendor_name} for PKR ${result.total_amount}.`,
            result.id,
            'VendorPurchase'
        );

        res.status(201).json({ success: true, purchase: result });
    } catch (error) {
        const isValidationError = error.message.includes('exists in stock') || error.message.includes('required');
        if (!isValidationError) {
            console.error('createPurchase error:', error);
        }
        res.status(isValidationError ? 400 : 500).json({
            success: false,
            message: error.message || 'Internal server error'
        });
    }
};

const updatePurchase = async (req, res) => {
    const { id } = req.params;
    const { outlet_id } = req.user;
    const { vendor_id, vendor_name, purchase_date, due_date, notes, items } = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    if (!items || !items.length) {
        return res.status(400).json({ success: false, message: 'Items are required.' });
    }

    try {
        // Fetch API product map before transaction
        const apiProductMap = await fetchApiProductMap();

        const result = await prisma.$transaction(async (tx) => {
            const purchase = await tx.vendorPurchase.findUnique({
                where: { id: parseInt(id) },
                include: { items: true }
            });

            if (!purchase || purchase.outlet_id !== outlet_id) {
                throw new Error('Purchase not found.');
            }

            // Save previous state for history
            const previousData = { ...purchase };

            // 1. Resolve Vendor
            let finalVendorId = vendor_id ? parseInt(vendor_id) : purchase.vendor_id;
            let finalVendorName = vendor_name || purchase.vendor_name;

            if (!finalVendorId && vendor_name && vendor_name !== purchase.vendor_name) {
                let existingVendor = await tx.vendor.findFirst({
                    where: { outlet_id, name: vendor_name }
                });
                if (!existingVendor) {
                    existingVendor = await tx.vendor.create({
                        data: { outlet_id, name: vendor_name }
                    });
                }
                finalVendorId = existingVendor.id;
                finalVendorName = existingVendor.name;
            }

            // 2. Handle Items Diff
            const oldItems = purchase.items;
            let newTotalAmount = 0;
            const changeLogs = [];

            const incomingIds = items.filter(i => i.id).map(i => parseInt(i.id));

            // Find deleted items
            const deletedItems = oldItems.filter(oldItem => !incomingIds.includes(oldItem.id));

            for (const item of deletedItems) {
                if (item.imei_serial) {
                    const connectedDelivery = await tx.delivery.findFirst({
                        where: { product_imei: item.imei_serial }
                    });
                    if (connectedDelivery) throw new Error(`Cannot delete item. IMEI ${item.imei_serial} is connected to a delivery.`);

                    const soldItem = await tx.outletInventory.findFirst({
                        where: { imei_serial: item.imei_serial, status: 'Sold' }
                    });
                    if (soldItem) throw new Error(`Cannot delete item. IMEI ${item.imei_serial} has already been sold.`);
                }

                const inventoryItem = await tx.outletInventory.findFirst({
                    where: {
                        outlet_id: purchase.outlet_id,
                        product_name: item.product_name,
                        imei_serial: item.imei_serial ? item.imei_serial.trim() : null,
                        OR: [
                            { color_variant: item.color_variant || null },
                            { color_variant: item.color_variant || "" }
                        ]
                    }
                });

                if (inventoryItem) {
                    if (inventoryItem.quantity < item.quantity) {
                        throw new Error(`Cannot delete item. Some units of ${item.product_name} have already been processed.`);
                    }
                    const newQty = inventoryItem.quantity - item.quantity;
                    if (newQty <= 0) {
                        await tx.outletInventory.delete({ where: { id: inventoryItem.id } });
                    } else {
                        await tx.outletInventory.update({
                            where: { id: inventoryItem.id },
                            data: { quantity: newQty }
                        });
                    }
                }
                await tx.vendorPurchaseItem.delete({ where: { id: item.id } });
                changeLogs.push(`Removed item: ${item.product_name} (Qty: ${item.quantity})`);
            }

            // Process incoming items
            for (const item of items) {
                const qty = parseInt(item.quantity) || 1;
                const unitPrice = parseFloat(item.unit_price) || 0;
                const totalPrice = qty * unitPrice;
                newTotalAmount += totalPrice;

                const currentImei = item.imei_serial ? item.imei_serial.trim() : null;

                if (item.id) {
                    // Update existing item
                    const oldItem = oldItems.find(o => o.id === parseInt(item.id));
                    if (!oldItem) throw new Error(`Item ${item.id} not found in this purchase.`);

                    const oldImei = oldItem.imei_serial ? oldItem.imei_serial.trim() : null;

                    if (oldImei !== currentImei) {
                        if (oldImei) {
                            const soldItem = await tx.outletInventory.findFirst({
                                where: { imei_serial: oldImei, status: 'Sold' }
                            });
                            if (soldItem) throw new Error(`Cannot edit item. Old IMEI ${oldImei} has already been sold.`);
                        }

                        if (currentImei) {
                            const duplicate = await tx.outletInventory.findFirst({
                                where: { imei_serial: currentImei }
                            });
                            if (duplicate) {
                                const oldInv = await tx.outletInventory.findFirst({
                                    where: { outlet_id, imei_serial: oldImei }
                                });
                                if (!oldInv || duplicate.id !== oldInv.id) {
                                    throw new Error(`IMEI/Serial ${currentImei} already exists.`);
                                }
                            }
                        }
                    }

                    const qtyDiff = qty - oldItem.quantity;
                    if (oldImei !== currentImei) {
                        changeLogs.push(`Changed IMEI for ${item.product_name} from ${oldImei || 'None'} to ${currentImei || 'None'}`);
                    }
                    if (qtyDiff !== 0) {
                        changeLogs.push(`Changed Quantity for ${item.product_name} from ${oldItem.quantity} to ${qty}`);
                    }
                    if (oldItem.unit_price !== unitPrice) {
                        changeLogs.push(`Changed Price for ${item.product_name} from ${oldItem.unit_price} to ${unitPrice}`);
                    }

                    let oldInvItem = await tx.outletInventory.findFirst({
                        where: {
                            outlet_id,
                            product_name: oldItem.product_name,
                            imei_serial: oldImei,
                            OR: [
                                { color_variant: oldItem.color_variant || null },
                                { color_variant: oldItem.color_variant || "" }
                            ]
                        }
                    });

                    if (oldInvItem) {
                        if (qtyDiff < 0 && oldInvItem.quantity + qtyDiff < 0) {
                            throw new Error(`Cannot reduce quantity. Not enough units of ${oldItem.product_name} in stock.`);
                        }

                        // Resolve plans from API or fallback
                        const apiProductUpd = apiProductMap.get((item.product_name || '').trim().toLowerCase());
                        let updPlans, updSalePrice = null, updApiName = null;
                        if (apiProductUpd && apiProductUpd.ProductInstallments && apiProductUpd.ProductInstallments.length > 0) {
                            updPlans = mapApiInstallments(apiProductUpd.ProductInstallments);
                            updSalePrice = parseFloat(apiProductUpd.price) || null;
                            updApiName = apiProductUpd.name;
                        } else {
                            updPlans = generateInstallments(item.category || oldInvItem.category || '', unitPrice);
                        }

                        await tx.outletInventory.update({
                            where: { id: oldInvItem.id },
                            data: {
                                quantity: oldInvItem.quantity + qtyDiff,
                                product_name: item.product_name,
                                category: item.category || oldInvItem.category,
                                color_variant: item.color_variant || oldInvItem.color_variant,
                                imei_serial: currentImei,
                                purchase_price: unitPrice,
                                installment_plans: updPlans,
                                sale_price: updSalePrice,
                                api_product_name: updApiName
                            }
                        });
                    }

                    await tx.vendorPurchaseItem.update({
                        where: { id: oldItem.id },
                        data: {
                            product_name: item.product_name,
                            category: item.category,
                            color_variant: item.color_variant,
                            imei_serial: currentImei,
                            quantity: qty,
                            unit_price: unitPrice,
                            total_price: totalPrice
                        }
                    });

                } else {
                    if (currentImei) {
                        const duplicate = await tx.outletInventory.findFirst({
                            where: { imei_serial: currentImei }
                        });
                        if (duplicate) throw new Error(`IMEI/Serial ${currentImei} already exists.`);
                    }

                    const existingItem = await tx.outletInventory.findFirst({
                        where: {
                            outlet_id,
                            product_name: item.product_name,
                            imei_serial: currentImei,
                            OR: [
                                { color_variant: item.color_variant || null },
                                { color_variant: item.color_variant || "" }
                            ]
                        }
                    });

                    // Resolve API plans for new items
                    const apiProductNew = apiProductMap.get((item.product_name || '').trim().toLowerCase());
                    let newPlans, newSalePrice = null, newApiName = null;
                    if (apiProductNew && apiProductNew.ProductInstallments && apiProductNew.ProductInstallments.length > 0) {
                        newPlans = mapApiInstallments(apiProductNew.ProductInstallments);
                        newSalePrice = parseFloat(apiProductNew.price) || null;
                        newApiName = apiProductNew.name;
                    } else {
                        newPlans = generateInstallments(item.category || '', unitPrice);
                    }

                    if (existingItem) {
                        await tx.outletInventory.update({
                            where: { id: existingItem.id },
                            data: {
                                quantity: existingItem.quantity + qty,
                                purchase_price: unitPrice,
                                installment_plans: newPlans,
                                sale_price: newSalePrice,
                                api_product_name: newApiName
                            }
                        });
                    } else {
                        await tx.outletInventory.create({
                            data: {
                                outlet_id,
                                product_name: item.product_name,
                                category: item.category,
                                color_variant: item.color_variant,
                                imei_serial: currentImei,
                                quantity: qty,
                                purchase_price: unitPrice,
                                installment_price: 0,
                                installment_plans: newPlans,
                                sale_price: newSalePrice,
                                api_product_name: newApiName,
                                status: 'In Stock'
                            }
                        });
                    }

                    await tx.vendorPurchaseItem.create({
                        data: {
                            purchase_id: purchase.id,
                            product_name: item.product_name,
                            category: item.category,
                            color_variant: item.color_variant,
                            imei_serial: currentImei,
                            quantity: qty,
                            unit_price: unitPrice,
                            total_price: totalPrice
                        }
                    });
                    changeLogs.push(`Added item: ${item.product_name} (Qty: ${qty})`);
                }
            }

            // 3. Update Purchase amounts and details
            const amountDiff = newTotalAmount - purchase.total_amount;
            const newBalance = purchase.balance + amountDiff;

            let newStatus = purchase.status;
            if (newBalance <= 0 && purchase.paid_amount > 0) newStatus = 'Paid';
            else if (purchase.paid_amount > 0) newStatus = 'Partial';
            else newStatus = 'Unpaid';

            const updatedPurchase = await tx.vendorPurchase.update({
                where: { id: purchase.id },
                data: {
                    vendor_id: finalVendorId,
                    vendor_name: finalVendorName,
                    total_amount: newTotalAmount,
                    balance: newBalance,
                    status: newStatus,
                    purchase_date: purchase_date ? new Date(purchase_date) : purchase.purchase_date,
                    due_date: due_date ? new Date(due_date) : purchase.due_date,
                    notes: notes !== undefined ? notes : purchase.notes
                },
                include: { items: true }
            });

            // 4. Update Vendor Balance
            if (purchase.vendor_id !== finalVendorId) {
                if (purchase.vendor_id) {
                    await tx.vendor.update({
                        where: { id: purchase.vendor_id },
                        data: { balance: { decrement: purchase.balance } }
                    });
                }
                if (finalVendorId) {
                    await tx.vendor.update({
                        where: { id: finalVendorId },
                        data: { balance: { increment: newBalance } }
                    });
                }
            } else if (finalVendorId && amountDiff !== 0) {
                await tx.vendor.update({
                    where: { id: finalVendorId },
                    data: { balance: { increment: amountDiff } }
                });
            }

            if (amountDiff !== 0) {
                changeLogs.push(`Total amount changed from ${purchase.total_amount} to ${newTotalAmount}`);
            }

            const finalSummary = changeLogs.length > 0 ? changeLogs.join('\n') : 'Purchase details updated.';

            // 5. Log Edit History
            await tx.vendorPurchaseEditHistory.create({
                data: {
                    purchase_id: purchase.id,
                    edited_by_id: req.user.id,
                    previous_data: previousData,
                    new_data: updatedPurchase,
                    changes_summary: finalSummary
                }
            });

            return updatedPurchase;
        }, {
            maxWait: 5000,
            timeout: 15000
        });

        await logAction(
            req,
            'VENDOR_PURCHASE_EDIT',
            `Edited purchase ${result.invoice_number} from ${result.vendor_name}.`,
            result.id,
            'VendorPurchase'
        );

        res.json({ success: true, purchase: result, message: 'Purchase updated successfully.' });
    } catch (error) {
        const isValidationError = error.message.includes('Cannot delete') || error.message.includes('exists') || error.message.includes('required') || error.message.includes('Cannot reduce') || error.message.includes('Cannot edit');
        if (!isValidationError) {
            console.error('updatePurchase error:', error);
        }
        res.status(isValidationError ? 400 : 500).json({
            success: false,
            message: error.message || 'Internal server error'
        });
    }
};

const recordPayment = async (req, res) => {
    const { outlet_id } = req.user;
    const { purchase_id, amount, payment_method, notes } = req.body;

    if (!purchase_id || !amount) {
        return res.status(400).json({ success: false, message: 'Purchase ID and amount are required.' });
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            const purchase = await tx.vendorPurchase.findUnique({
                where: { id: parseInt(purchase_id) }
            });

            if (!purchase || purchase.outlet_id !== outlet_id) {
                throw new Error('Purchase not found.');
            }

            const amtNum = parseFloat(amount);
            const newPaidAmount = purchase.paid_amount + amtNum;
            const newBalance = purchase.total_amount - newPaidAmount;
            let status = 'Partial';
            if (newBalance <= 0) status = 'Paid';
            if (newPaidAmount === 0) status = 'Unpaid';

            const payment = await tx.vendorPayment.create({
                data: {
                    outlet_id,
                    purchase_id: purchase.id,
                    vendor_id: purchase.vendor_id,
                    vendor_name: purchase.vendor_name,
                    amount: amtNum,
                    payment_method,
                    notes
                }
            });

            await tx.vendorPurchase.update({
                where: { id: purchase.id },
                data: {
                    paid_amount: newPaidAmount,
                    balance: newBalance,
                    status
                }
            });

            // Update Vendor Global Balance
            if (purchase.vendor_id) {
                await tx.vendor.update({
                    where: { id: purchase.vendor_id },
                    data: { balance: { decrement: amtNum } }
                });
            }

            // Update Cash Register (Vendor Payment is an outflow)
            await updateCashRegister(tx, outlet_id, 'vendor_payments', amtNum, 'add');

            return payment;
        }, {
            maxWait: 5000,
            timeout: 15000
        });

        await logAction(
            req,
            'VENDOR_PAYMENT',
            `Paid PKR ${result.amount} to ${result.vendor_name} for invoice ${result.purchase_id}.`,
            result.id,
            'VendorPayment'
        );

        res.json({ success: true, payment: result });
    } catch (error) {
        console.error('recordPayment error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};

const getVendorLedger = async (req, res) => {
    const { id } = req.params;
    const { outlet_id } = req.user;

    try {
        const vendor = await prisma.vendor.findFirst({
            where: { id: parseInt(id), outlet_id },
            include: { returns: true }
        });

        if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });

        const purchases = await prisma.vendorPurchase.findMany({
            where: { vendor_id: vendor.id },
            include: { items: true },
            orderBy: { purchase_date: 'desc' }
        });

        const payments = await prisma.vendorPayment.findMany({
            where: { vendor_id: vendor.id },
            orderBy: { created_at: 'desc' }
        });

        // Merge and Sort
        const ledger = [
            ...purchases.map(p => ({
                id: p.id,
                type: 'Purchase',
                reference: p.invoice_number,
                date: p.purchase_date,
                due_date: p.due_date,
                amount: p.total_amount,
                debit: p.total_amount, // Balance Increase
                credit: 0,
                notes: p.notes
            })),
            ...payments.map(py => ({
                id: py.id,
                type: 'Payment',
                reference: `PAY-${py.id}`,
                date: py.created_at,
                amount: py.amount,
                debit: 0,
                credit: py.amount, // Balance Decrease
                notes: py.notes
            })),
            ...(vendor.returns || []).map(r => ({
                id: r.id,
                type: 'Return',
                reference: r.return_number,
                date: r.return_date,
                amount: r.total_amount,
                debit: 0,
                credit: r.total_amount, // Balance Decrease
                notes: r.notes
            }))
        ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        // Calculate running balance
        let runBal = 0;
        const ledgerWithBalance = ledger.map(entry => {
            runBal += (entry.debit - entry.credit);
            return { ...entry, running_balance: runBal };
        });

        res.json({
            success: true,
            vendor,
            ledger: ledgerWithBalance.reverse() // Newest first for UI 
        });
    } catch (error) {
        console.error('getVendorLedger error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// --- Other getters ---

const getPurchases = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const purchases = await prisma.vendorPurchase.findMany({
            where: { outlet_id },
            include: {
                items: true,
                vendor: true,
                returns: {
                    include: { items: true }
                }
            },
            orderBy: { created_at: 'desc' }
        });
        res.json({ success: true, purchases });
    } catch (error) {
        console.error('getPurchases error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getPurchaseById = async (req, res) => {
    const { id } = req.params;
    const { outlet_id } = req.user;

    try {
        const purchase = await prisma.vendorPurchase.findFirst({
            where: { id: parseInt(id), outlet_id },
            include: { items: true, payments: true, vendor: true }
        });

        if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });
        res.json({ success: true, purchase });
    } catch (error) {
        console.error('getPurchaseById error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getPurchaseHistory = async (req, res) => {
    const { id } = req.params;
    const { outlet_id } = req.user;

    try {
        const purchase = await prisma.vendorPurchase.findUnique({
            where: { id: parseInt(id) }
        });

        if (!purchase || purchase.outlet_id !== outlet_id) {
            return res.status(404).json({ success: false, message: 'Purchase not found.' });
        }

        const history = await prisma.vendorPurchaseEditHistory.findMany({
            where: { purchase_id: parseInt(id) },
            include: { user: { select: { full_name: true, username: true } } },
            orderBy: { edited_at: 'desc' }
        });

        res.json({ success: true, history });
    } catch (error) {
        console.error('getPurchaseHistory error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const getVendorSummary = async (req, res) => {
    const { outlet_id } = req.user;

    try {
        // We aggregate from VendorPurchase to get total_amount and paid_amount
        // and link to Vendor to get the formal name/id
        const summary = await prisma.vendorPurchase.groupBy({
            by: ['vendor_name', 'vendor_id'],
            where: { outlet_id },
            _sum: {
                total_amount: true,
                paid_amount: true,
                balance: true
            }
        });

        // Map it to include _sum structure for frontend compatibility
        const formattedSummary = summary.map(s => ({
            vendor_name: s.vendor_name,
            vendor_id: s.vendor_id,
            _sum: {
                total_amount: s._sum.total_amount || 0,
                paid_amount: s._sum.paid_amount || 0,
                balance: s._sum.balance || 0
            }
        }));

        res.json({ success: true, summary: formattedSummary });
    } catch (error) {
        console.error('getVendorSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getPayments = async (req, res) => {
    const { outlet_id } = req.user;
    try {
        const payments = await prisma.vendorPayment.findMany({
            where: { outlet_id },
            include: { vendor: true },
            orderBy: { created_at: 'desc' }
        });
        res.json({ success: true, payments });
    } catch (error) {
        console.error('getPayments error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const deletePurchase = async (req, res) => {
    const { id } = req.params;
    const { outlet_id } = req.user;

    try {
        await prisma.$transaction(async (tx) => {
            const purchase = await tx.vendorPurchase.findUnique({
                where: { id: parseInt(id) },
                include: { items: true }
            });
            if (!purchase || purchase.outlet_id !== outlet_id) throw new Error('Not found');

            // 1. Revert Inventory
            for (const item of purchase.items) {
                // If the item has an IMEI/Serial, check if it's already sold or connected to an order
                if (item.imei_serial) {
                    // Check if connected to a delivery
                    const connectedDelivery = await tx.delivery.findFirst({
                        where: { product_imei: item.imei_serial },
                        include: { order: { select: { order_ref: true } } }
                    });
                    if (connectedDelivery) {
                        throw new Error(`Cannot delete purchase. Item with IMEI ${item.imei_serial} is connected to Order ${connectedDelivery.order?.order_ref || 'N/A'} via Delivery.`);
                    }

                    // Check if marked as Sold in inventory
                    const soldItem = await tx.outletInventory.findFirst({
                        where: {
                            imei_serial: item.imei_serial,
                            status: 'Sold'
                        }
                    });
                    if (soldItem) {
                        throw new Error(`Cannot delete purchase. Item with IMEI ${item.imei_serial} has already been sold.`);
                    }
                }

                const inventoryItem = await tx.outletInventory.findFirst({
                    where: {
                        outlet_id: purchase.outlet_id,
                        product_name: item.product_name,
                        imei_serial: item.imei_serial ? item.imei_serial.trim() : null,
                        // Match exactly what might be in the DB (null or empty string)
                        OR: [
                            { color_variant: item.color_variant || null },
                            { color_variant: item.color_variant || "" }
                        ]
                    }
                });

                if (!inventoryItem) {
                    throw new Error(`Inventory record for ${item.product_name} (IMEI: ${item.imei_serial || 'N/A'}) not found in your outlet.`);
                }

                if (inventoryItem.quantity < item.quantity) {
                    throw new Error(`Cannot delete purchase. Some units of ${item.product_name} have already been processed or sold.`);
                }

                const newQty = inventoryItem.quantity - item.quantity;
                if (newQty <= 0) {
                    // Delete if quantity becomes 0 or less
                    await tx.outletInventory.delete({ where: { id: inventoryItem.id } });
                } else {
                    // Reduce quantity
                    await tx.outletInventory.update({
                        where: { id: inventoryItem.id },
                        data: { quantity: newQty }
                    });
                }
            }

            // 2. Revert Vendor balance if linked
            if (purchase.vendor_id) {
                await tx.vendor.update({
                    where: { id: purchase.vendor_id },
                    data: { balance: { decrement: purchase.total_amount - purchase.paid_amount } }
                });
            }

            await tx.vendorPurchase.delete({ where: { id: purchase.id } });
        }, {
            maxWait: 5000,
            timeout: 15000
        });
        res.json({ success: true, message: 'Purchase deleted successfully.' });
    } catch (error) {
        // If it's a validation error we threw, send it as 400 without logging stack trace
        if (error.message.includes('Cannot delete purchase') || error.message.includes('Inventory record')) {
            return res.status(400).json({ success: false, message: error.message });
        }

        console.error('deletePurchase error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// --- Purchase Returns ---

const createPurchaseReturn = async (req, res) => {
    const { outlet_id } = req.user;
    const { purchase_id, vendor_id, return_date, notes, items } = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (!items || !items.length) return res.status(400).json({ success: false, message: 'Items are required.' });

    try {
        const result = await prisma.$transaction(async (tx) => {
            const return_number = await generateReturnNumber(tx);

            // 1. Resolve Vendor
            let finalVendorId = parseInt(vendor_id);
            const vendor = await tx.vendor.findUnique({ where: { id: finalVendorId } });
            if (!vendor) throw new Error('Vendor not found.');

            let totalReturnAmount = 0;
            const returnItemsData = [];

            for (const item of items) {
                const qty = parseInt(item.quantity) || 1;
                const unitPrice = parseFloat(item.unit_price) || 0;
                const totalPrice = qty * unitPrice;
                totalReturnAmount += totalPrice;

                returnItemsData.push({
                    purchase_item_id: item.purchase_item_id ? parseInt(item.purchase_item_id) : null,
                    product_name: item.product_name,
                    category: item.category,
                    color_variant: item.color_variant,
                    imei_serial: item.imei_serial ? item.imei_serial.trim() : null,
                    quantity: qty,
                    unit_price: unitPrice,
                    total_price: totalPrice,
                    reason: item.reason || 'Not specified'
                });

                // --- STOCK ADJUSTMENT ---
                // Find item in inventory
                const inventoryItem = await tx.outletInventory.findFirst({
                    where: {
                        outlet_id,
                        product_name: item.product_name,
                        imei_serial: item.imei_serial ? item.imei_serial.trim() : null,
                        OR: [
                            { color_variant: item.color_variant || null },
                            { color_variant: item.color_variant || "" }
                        ]
                    }
                });

                if (!inventoryItem) {
                    throw new Error(`Item ${item.product_name} not found in inventory.`);
                }

                if (inventoryItem.quantity < qty) {
                    throw new Error(`Not enough stock for ${item.product_name}. Available: ${inventoryItem.quantity}`);
                }

                // Check if IMEI is sold/assigned
                if (item.imei_serial) {
                    if (inventoryItem.status !== 'In Stock') {
                        throw new Error(`Item with IMEI ${item.imei_serial} is ${inventoryItem.status} and cannot be returned.`);
                    }
                }

                // Update or Delete from Inventory
                const newQty = inventoryItem.quantity - qty;
                if (newQty <= 0) {
                    await tx.outletInventory.delete({ where: { id: inventoryItem.id } });
                } else {
                    await tx.outletInventory.update({
                        where: { id: inventoryItem.id },
                        data: { quantity: newQty }
                    });
                }
            }

            // Create Return Record
            const purchaseReturn = await tx.vendorPurchaseReturn.create({
                data: {
                    outlet_id,
                    return_number,
                    purchase_id: purchase_id ? parseInt(purchase_id) : null,
                    vendor_id: finalVendorId,
                    vendor_name: vendor.name,
                    notes,
                    total_amount: totalReturnAmount,
                    return_date: return_date ? new Date(return_date) : new Date(),
                    items: {
                        create: returnItemsData
                    }
                },
                include: { items: true }
            });

            // Update Vendor Balance (Return reduces what we owe)
            await tx.vendor.update({
                where: { id: finalVendorId },
                data: { balance: { decrement: totalReturnAmount } }
            });

            // If linked to a purchase, adjust its balance too
            if (purchase_id) {
                const purchase = await tx.vendorPurchase.findUnique({ where: { id: parseInt(purchase_id) } });
                if (purchase) {
                    const newBalance = Math.max(0, purchase.balance - totalReturnAmount);
                    let newStatus = purchase.status;
                    if (newBalance <= 0 && purchase.paid_amount > 0) newStatus = 'Paid';
                    else if (newBalance <= 0) newStatus = 'Unpaid'; // Technically should be closed but balanced

                    await tx.vendorPurchase.update({
                        where: { id: purchase.id },
                        data: {
                            balance: newBalance,
                            status: newStatus
                        }
                    });
                }
            }

            return purchaseReturn;
        });

        await logAction(
            req,
            'VENDOR_PURCHASE_RETURN',
            `Recorded return ${result.return_number} to ${result.vendor_name} for PKR ${result.total_amount}.`,
            result.id,
            'VendorPurchaseReturn'
        );

        res.status(201).json({ success: true, purchaseReturn: result });
    } catch (error) {
        console.error('createPurchaseReturn error:', error);
        res.status(400).json({ success: false, message: error.message || 'Internal server error' });
    }
};

const getPurchaseReturns = async (req, res) => {
    const { outlet_id } = req.user;
    const { vendor_id } = req.query;

    try {
        const where = { outlet_id };
        if (vendor_id) where.vendor_id = parseInt(vendor_id);

        const returns = await prisma.vendorPurchaseReturn.findMany({
            where,
            include: { items: true, vendor: true, purchase: true },
            orderBy: { return_date: 'desc' }
        });
        res.json({ success: true, returns });
    } catch (error) {
        console.error('getPurchaseReturns error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getVendors,
    createVendor,
    updateVendor,
    createPurchase,
    getPurchases,
    getPurchaseById,
    updatePurchase,
    getPurchaseHistory,
    recordPayment,
    getVendorSummary,
    getPayments,
    deletePurchase,
    getVendorLedger,
    createPurchaseReturn,
    getPurchaseReturns
};
