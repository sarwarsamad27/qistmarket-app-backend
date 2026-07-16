const prisma = require('../../lib/prisma');

/**
 * Automatically syncs the blacklist status for all delivered orders.
 * If an order meets the blacklist criteria (90 days overdue), it marks the purchaser
 * and all linked grantors as blacklisted in the database.
 */
async function syncBlacklistStatus() {
    try {
        const today = new Date();
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(today.getDate() - 90);

        // Fetch all delivered orders that have an installment ledger
        const orders = await prisma.order.findMany({
            where: { is_delivered: true },
            include: {
                verification: {
                    include: {
                        purchaser: true,
                        grantors: true
                    }
                },
                delivery: {
                    include: {
                        installment_ledger: true
                    }
                }
            }
        });

        // Manually whitelisted CNICs (most recent action = 'whitelist') are protected
        // from being re-blacklisted by this automatic sync.
        const overrideActions = await prisma.blacklistAction.findMany({ orderBy: { created_at: 'desc' } });
        const latestActionByCnic = {};
        for (const o of overrideActions) {
            if (!(o.cnic in latestActionByCnic)) latestActionByCnic[o.cnic] = o.action;
        }
        const whitelistedCnics = new Set(
            Object.entries(latestActionByCnic).filter(([, action]) => action === 'whitelist').map(([cnic]) => cnic)
        );

        const blacklistedVerificationIds = [];

        for (const order of orders) {
            const purchaserCnic = order.verification?.purchaser?.cnic_number;
            if (purchaserCnic && whitelistedCnics.has(purchaserCnic)) continue;

            const ledgerModel = order.delivery?.installment_ledger;
            if (!ledgerModel || !ledgerModel.ledger_rows) continue;

            let rows = [];
            try {
                rows = Array.isArray(ledgerModel.ledger_rows)
                    ? ledgerModel.ledger_rows
                    : JSON.parse(ledgerModel.ledger_rows);
            } catch (e) { continue; }

            if (!Array.isArray(rows)) continue;

            const installments = rows.filter(r => r.month > 0);
            if (installments.length === 0) continue;

            let isBlacklisted = false;

            // Condition 1: No installments paid for 90 days since delivery
            const paidCount = installments.filter(r => r.status === 'paid' || r.status === 'Paid').length;
            const deliveryDate = new Date(order.delivery?.end_time || order.updated_at);
            if (paidCount === 0 && deliveryDate < ninetyDaysAgo) {
                isBlacklisted = true;
            }

            // Condition 2: Any installment overdue > 90 days
            if (!isBlacklisted) {
                isBlacklisted = installments.some(r => {
                    const dDate = r.due_date || r.dueDate;
                    if (!dDate) return false;
                    const dueDate = new Date(dDate);
                    return (r.status !== 'paid' && r.status !== 'Paid') && dueDate < ninetyDaysAgo;
                });
            }

            if (isBlacklisted && order.verification?.id) {
                blacklistedVerificationIds.push(order.verification.id);
            }
        }

        if (blacklistedVerificationIds.length > 0) {
            // Update PurchaserVerification
            await prisma.purchaserVerification.updateMany({
                where: { verification_id: { in: blacklistedVerificationIds } },
                data: { is_blacklisted: true }
            });

            // Update GrantorVerification
            await prisma.grantorVerification.updateMany({
                where: { verification_id: { in: blacklistedVerificationIds } },
                data: { is_blacklisted: true }
            });

            console.log(`[BlacklistSync] Successfully blacklisted ${blacklistedVerificationIds.length} verifications.`);
        }

        return { success: true, count: blacklistedVerificationIds.length };
    } catch (error) {
        console.error('[BlacklistSync] Error syncing blacklist status:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Checks if a name or CNIC is blacklisted.
 * Searches both PurchaserVerification and GrantorVerification.
 */
async function checkBlacklistStatus(cnic) {
    if (!cnic) return { isBlacklisted: false };

    const cleanCnic = cnic.trim();

    // Check PurchaserVerification
    const blacklistedPurchaser = await prisma.purchaserVerification.findFirst({
        where: {
            OR: [
                { cnic_number: cleanCnic },
            ],
            is_blacklisted: true
        }
    });

    if (blacklistedPurchaser) return { isBlacklisted: true, personType: 'Purchaser', details: blacklistedPurchaser };

    // Check GrantorVerification
    const blacklistedGrantor = await prisma.grantorVerification.findFirst({
        where: {
            OR: [
                { cnic_number: cleanCnic },
            ],
            is_blacklisted: true
        }
    });

    if (blacklistedGrantor) return { isBlacklisted: true, personType: 'Grantor', details: blacklistedGrantor };

    return { isBlacklisted: false };
}

module.exports = {
    syncBlacklistStatus,
    checkBlacklistStatus
};
