const prisma = require('./lib/prisma');

async function seedAccountantRole() {
  try {
    console.log('Seeding Accountant role...');

    const existing = await prisma.role.findFirst({ where: { name: 'Accountant' } });
    if (existing) {
      console.log('Accountant role already exists (id: ' + existing.id + ')');
      return;
    }

    const role = await prisma.role.create({
      data: { name: 'Accountant' },
    });

    console.log('Accountant role created successfully (id: ' + role.id + ')');
  } catch (error) {
    console.error('Error seeding Accountant role:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

seedAccountantRole();
