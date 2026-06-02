const { PrismaClient } = require('@prisma/client');

// ─── PKT Date Override ───────────────────────────────────────────
const _OriginalDate = global.Date;

function PKTDate(...args) {
  if (args.length === 0) {
    return new _OriginalDate(_OriginalDate.now() + 5 * 60 * 60 * 1000);
  }
  return new _OriginalDate(...args);
}

PKTDate.now = () => _OriginalDate.now() + 5 * 60 * 60 * 1000;
PKTDate.UTC = _OriginalDate.UTC;
PKTDate.parse = _OriginalDate.parse;
PKTDate.prototype = _OriginalDate.prototype;

global.Date = PKTDate;
// ────────────────────────────────────────────────────────────────

const prismaClient = global.prisma || new PrismaClient();

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