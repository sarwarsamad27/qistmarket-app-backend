const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkUserOrders(userId) {
    const start = new Date(); 
    start.setHours(0,0,0,0);
    
    const orders = await prisma.order.findMany({
        where: { 
            created_by_user_id: userId,
            updated_at: { gte: start },
            status: 'delivered'
        },
        include: {
            customer: true,
            verification: {
                include: {
                    purchaser: true
                }
            }
        }
    });
    
    console.log(`User ${userId} has ${orders.length} delivered orders today.`);
    orders.forEach(o => {
        console.log(`Order ID: ${o.id}, Customer ID: ${o.customer_id}, Mobile: ${o.whatsapp_number}, CNIC: ${o.verification?.purchaser?.cnic_number}`);
    });

    const uniqueCustomerIds = new Set(orders.map(o => o.customer_id).filter(Boolean));
    console.log(`Unique Customers (ID based): ${uniqueCustomerIds.size}`);
}

checkUserOrders(39).catch(console.error).finally(() => prisma.$disconnect());
