const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function migrate() {
  console.log('Starting migration of cash transactions to OfficerTransaction table...');
  
  // Clear existing if any (safe for rerun during dev)
  await prisma.officerTransaction.deleteMany({});
  
  const officers = await prisma.user.findMany({
    where: {
      cash_in_hand: { some: {} }
    },
    select: { id: true }
  });

  console.log(`Found ${officers.length} officers with cash transactions.`);

  let totalMigrated = 0;

  for (const officer of officers) {
    const officerId = officer.id;
    
    // Fetch all credits (CashInHand)
    const credits = await prisma.cashInHand.findMany({
      where: { officer_id: officerId },
      include: { order: { select: { order_ref: true } } }
    });
    
    // Fetch all debits (CashSubmissionHistory)
    const debits = await prisma.cashSubmissionHistory.findMany({
      where: { cash_in_hand: { officer_id: officerId } },
      include: { cash_in_hand: { include: { order: { select: { order_ref: true } } } } }
    });
    
    // Combine and sort chronologically
    const allTransactions = [];
    
    for (const c of credits) {
      allTransactions.push({
        _id: `credit_${c.id}`,
        officer_id: officerId,
        type: 'credit',
        amount: c.amount,
        status: c.status,
        description: `${c.cash_type || 'Cash'} received from ${c.customer_name || 'Customer'}`,
        transaction_date: c.created_at,
        payment_method: c.payment_method,
        order_ref: c.order?.order_ref || null,
        submission_ref: null
      });
    }
    
    for (const d of debits) {
      allTransactions.push({
        _id: `debit_${d.id}`,
        officer_id: officerId,
        type: 'debit',
        amount: d.amount_submitted,
        status: 'paid', // submission is paid
        description: `Cash submitted to outlet`,
        transaction_date: d.submission_date,
        payment_method: d.cash_in_hand?.payment_method || 'Cash',
        order_ref: d.cash_in_hand?.order?.order_ref || null,
        submission_ref: d.submission_ref
      });
    }
    
    allTransactions.sort((a, b) => new Date(a.transaction_date).getTime() - new Date(b.transaction_date).getTime());
    
    let currentBalance = 0;
    
    for (const tx of allTransactions) {
      if (tx.type === 'credit') {
        currentBalance += tx.amount;
      } else {
        currentBalance -= tx.amount;
      }
      
      const transaction_id = `TXN-${new Date(tx.transaction_date).getTime()}-${Math.floor(Math.random() * 10000)}`;
      
      await prisma.officerTransaction.create({
        data: {
          transaction_id,
          officer_id: tx.officer_id,
          type: tx.type,
          amount: tx.amount,
          balance: currentBalance,
          status: tx.status,
          description: tx.description,
          transaction_date: tx.transaction_date,
          payment_method: tx.payment_method,
          order_ref: tx.order_ref,
          submission_ref: tx.submission_ref
        }
      });
      totalMigrated++;
    }
  }

  console.log(`Migration complete. Migrated ${totalMigrated} transactions.`);
}

migrate()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
