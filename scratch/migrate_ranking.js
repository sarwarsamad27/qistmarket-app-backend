const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { getOrCreateCustomer, updateCsrRanking } = require('../src/services/rankingService');

async function migrate() {
    console.log('Starting migration...');

    // 1. Get all orders
    const orders = await prisma.order.findMany({
        orderBy: { id: 'asc' }
    });

    console.log(`Found ${orders.length} orders to process.`);

    for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        try {
            await getOrCreateCustomer(order.id);
            if ((i + 1) % 100 === 0) {
                console.log(`Processed ${i + 1}/${orders.length} orders...`);
            }
        } catch (err) {
            console.error(`Failed to process order ${order.id}:`, err.message);
        }
    }

    console.log('All orders linked to customers.');

    // 2. Identify all CSRs (users with created_orders)
    const csrs = await prisma.user.findMany({
        where: {
            created_orders: { some: {} }
        },
        select: { id: true }
    });

    console.log(`Recalculating rankings for ${csrs.length} CSRs...`);

    for (let i = 0; i < csrs.length; i++) {
        const csr = csrs[i];
        try {
            await updateCsrRanking(csr.id, 'month');
            await updateCsrRanking(csr.id, 'today');
            console.log(`Updated ranking for CSR ${csr.id}`);
        } catch (err) {
            console.error(`Failed to update ranking for CSR ${csr.id}:`, err.message);
        }
    }

    console.log('Migration complete!');
}

migrate()
    .catch(err => {
        console.error('Migration failed:', err);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
