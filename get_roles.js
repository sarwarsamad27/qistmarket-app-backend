const prisma = require('../../lib/prisma');
async function run() {
  const roles = await prisma.role.findMany({ select: { id: true, name: true } });
  console.log(JSON.stringify(roles, null, 2));
}
run().finally(() => prisma.$disconnect());
