/**
 * seedConsumerNumbers.js
 * 
 * Ek dafa chalao — yeh script existing sabhi users ke liye
 * 1Bill aur SmartPay consumer numbers generate karegi
 * jinke paas pehle se nahi hain.
 */

process.env.TZ = 'Asia/Karachi';
require('dotenv').config();

const prisma = require('./lib/prisma');
const { generateConsumerNumber, generateSmartPayConsumerNumber } = require('./src/utils/consumerNumberUtils');

const now = () => new Date();

async function seedConsumerNumbers() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Consumer Number Seeding Script (Proper Rule Version)');
  console.log('═══════════════════════════════════════════════════════');

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { bill_consumer_number: null },
        { smart_pay_consumer_number: null },
      ]
    },
    select: {
      id: true,
      full_name: true,
      phone: true,
      bill_consumer_number: true,
      smart_pay_consumer_number: true,
    },
    orderBy: { id: 'asc' }
  });

  if (users.length === 0) {
    console.log('✅ All users already have consumer numbers. Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  console.log(`\nFound ${users.length} user(s) without consumer numbers.\n`);

  let created = 0;
  let errors = 0;

  const dueDate = new Date();
  dueDate.setFullYear(dueDate.getFullYear() + 10);

  for (const user of users) {
    try {
      let billConsumerNumber = user.bill_consumer_number;
      let smartPayConsumerNumber = user.smart_pay_consumer_number;

      const toCreate = [];

      if (!billConsumerNumber) {
        billConsumerNumber = await generateConsumerNumber(null, user.phone);
        toCreate.push({
          consumer_number: billConsumerNumber,
          user_id: user.id,
          type: 'officer_cash',
          customer_name: user.full_name,
          mobile_number: user.phone,
          amount_due: 0,
          billing_month: '2401',
          due_date: dueDate,
          bill_status: 'P',
          created_at: now(),
          updated_at: now(),
        });
      }

      if (!smartPayConsumerNumber) {
        smartPayConsumerNumber = await generateSmartPayConsumerNumber(null, user.phone);
        toCreate.push({
          consumer_number: smartPayConsumerNumber,
          user_id: user.id,
          type: 'officer_cash',
          customer_name: user.full_name,
          mobile_number: user.phone,
          amount_due: 0,
          billing_month: '2401',
          due_date: dueDate,
          bill_status: 'P',
          created_at: now(),
          updated_at: now(),
        });
      }

      await prisma.user.update({
        where: { id: user.id },
        data: {
          bill_consumer_number: billConsumerNumber,
          smart_pay_consumer_number: smartPayConsumerNumber,
        },
      });

      if (toCreate.length > 0) {
        await prisma.consumerNumber.createMany({ data: toCreate });
      }

      console.log(`  ✅ User #${user.id} (${user.full_name})`);
      console.log(`       1Bill:    ${billConsumerNumber}`);
      console.log(`       SmartPay: ${smartPayConsumerNumber}`);
      created++;
    } catch (err) {
      console.error(`  ❌ User #${user.id} (${user.full_name}) — ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Done!  ✅ Processed: ${created}  ⚠️  Errors: ${errors}`);
  console.log('═══════════════════════════════════════════════════════\n');

  await prisma.$disconnect();
}

seedConsumerNumbers().catch(async (err) => {
  console.error('Fatal error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
