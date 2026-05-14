const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function restoreOrderDates() {
  try {
    console.log('Starting restoration of Order updated_at fields...');

    // 1. Get all orders
    const orders = await prisma.order.findMany({
      select: {
        id: true,
        order_ref: true,
        created_at: true,
        updated_at: true,
        status: true,
        statusHistories: {
          orderBy: { created_at: 'desc' },
          take: 1,
          select: { created_at: true }
        }
      }
    });

    console.log(`Found ${orders.length} orders to check.`);
    let updateCount = 0;

    for (const order of orders) {
      const latestHistoryTime = order.statusHistories[0]?.created_at;
      const targetTime = latestHistoryTime || order.created_at;

      // Only update if current updated_at is significantly newer than history (e.g. within the migration window)
      // Migration seems to have happened around Wed May 13 21:12:24 2026.
      // But let's just restore if they are different by more than a minute.
      const diffSeconds = Math.abs(order.updated_at.getTime() - targetTime.getTime()) / 1000;

      if (diffSeconds > 60) {
        // Use raw SQL to bypass Prisma's automatic @updatedAt override
        const targetTimeStr = targetTime.toISOString().slice(0, 19).replace('T', ' ');
        await prisma.$executeRaw`UPDATE \`Order\` SET updated_at = ${targetTime} WHERE id = ${order.id}`;
        updateCount++;
        
        if (updateCount % 100 === 0) {
          console.log(`Updated ${updateCount} orders...`);
        }
      }
    }

    console.log(`Successfully restored ${updateCount} order dates.`);

  } catch (err) {
    console.error('Restoration failed:', err);
  } finally {
    await prisma.$disconnect();
  }
}

restoreOrderDates();
