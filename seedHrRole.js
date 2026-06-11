const prisma = require('./lib/prisma');

async function seedHrRole() {
  try {
    console.log('Seeding HR role...');

    const existing = await prisma.role.findFirst({ where: { name: 'HR' } });
    if (existing) {
      console.log('HR role already exists (id: ' + existing.id + ')');
      return;
    }

    await prisma.role.create({
      data: { name: 'HR' },
    });

    console.log('HR role created successfully.');
  } catch (error) {
    console.error('Error seeding HR role:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

seedHrRole();
