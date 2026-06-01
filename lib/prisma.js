const { PrismaClient } = require('@prisma/client');

// PKT offset: UTC+5
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

// Override global Date so Prisma always gets PKT time
const OriginalDate = Date;
class PKTDate extends OriginalDate {
  constructor(...args) {
    if (args.length === 0) {
      super(new OriginalDate().getTime() + PKT_OFFSET_MS);
    } else {
      super(...args);
    }
  }
  static now() {
    return new OriginalDate().getTime() + PKT_OFFSET_MS;
  }
}
global.Date = PKTDate;

const prismaClient = global.prisma || new PrismaClient();

prismaClient.$connect().then(async () => {
  await prismaClient.$executeRawUnsafe(`SET time_zone = '+05:00'`);
  console.log('MySQL timezone set to PKT (+05:00) ✅');
}).catch(err => {
  console.error('Timezone set error:', err.message);
});

const prisma = prismaClient.$extends({
    query: {
        order: {
            async update({ args, query }) {
                const data = args.data;
                const status = data.status;
                if (status === 'delivered') {
                    data.updated_at = new Date();
                } else if (status && status !== 'delivered') {
                    data.updated_at = new Date();
                } else {
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