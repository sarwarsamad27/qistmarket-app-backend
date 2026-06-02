const { PrismaClient } = require('@prisma/client');

const prismaClient = global.prisma || new PrismaClient();

// Use Prisma Extensions instead of deprecated Middleware ($use)
const prisma = prismaClient.$extends({
    query: {
        order: {
            async update({ args, query }) {
                const data = args.data;
                const status = data.status;

                // 1. If status is becoming 'delivered', we update the timestamp to now
                if (status === 'delivered') {
                    data.updated_at = new Date();
                } 
                // 2. If status is becoming something else (not delivered), we also update timestamp
                else if (status && status !== 'delivered') {
                    data.updated_at = new Date();
                }
                // 3. If status is not being changed, we only update timestamp if the order isn't already delivered
                else {
                    const currentOrder = await prismaClient.order.findUnique({
                        where: args.where,
                        select: { status: true }
                    });
                    if (currentOrder && currentOrder.status !== 'delivered') {
                        data.updated_at = new Date();
                    }
                }
                return query(args);
            },
            async updateMany({ args, query }) {
                // For bulk updates, if status is becoming something other than delivered, update timestamp
                if (args.data.status && args.data.status !== 'delivered') {
                    args.data.updated_at = new Date();
                }
                return query(args);
            }
        }
    }
});

if (process.env.NODE_ENV !== 'production') {
    global.prisma = prismaClient;
}

module.exports = prisma;