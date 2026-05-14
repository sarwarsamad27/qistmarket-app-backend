const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkDates() {
  try {
    const orders = await prisma.order.findMany({
      take: 10,
      orderBy: { updated_at: 'desc' },
      select: {
        id: true,
        order_ref: true,
        status: true,
        updated_at: true,
        statusHistories: {
          orderBy: { created_at: 'desc' },
          take: 1,
          select: { created_at: true }
        }
      }
    });

    console.log('Sample Orders and their latest history entries:');
    orders.forEach(o => {
      console.log(`Order ${o.order_ref} (${o.status}):`);
      console.log(`  Current updated_at: ${o.updated_at}`);
      console.log(`  Latest history entry: ${o.statusHistories[0]?.created_at || 'None'}`);
    });

  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

checkDates();
