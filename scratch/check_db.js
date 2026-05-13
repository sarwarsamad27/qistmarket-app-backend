const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const start = new Date(); 
    start.setHours(0,0,0,0);
    
    console.log('Searching for orders updated after:', start.toISOString());

    const orders = await prisma.order.findMany({
        where: { 
            updated_at: { gte: start },
            status: 'delivered'
        },
        select: { 
            id: true, 
            status: true, 
            updated_at: true, 
            created_by_user_id: true,
            customer_name: true
        }
    });
    
    console.log('Delivered orders today count:', orders.length);
    console.log('Orders:', orders);

    // Check CSRs
    const csrs = await prisma.user.findMany({
        where: { role: { name: 'Sales Officer' } },
        select: { id: true, full_name: true }
    });
    console.log('Sales Officers:', csrs.map(c => `${c.id}: ${c.full_name}`));
}

check().catch(console.error).finally(() => prisma.$disconnect());
