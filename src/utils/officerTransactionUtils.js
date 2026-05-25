const prisma = require('../../lib/prisma');

async function createOfficerTransaction(data, tx = prisma) {
  const { officer_id, type, amount, status, description, payment_method, order_ref, submission_ref } = data;

  // Ensure amount is float
  const parsedAmount = parseFloat(amount) || 0;

  // Get last transaction to calculate balance
  const lastTx = await tx.officerTransaction.findFirst({
    where: { officer_id },
    orderBy: { id: 'desc' }
  });

  const previousBalance = lastTx?.balance || 0;
  const balance = type === 'credit' ? previousBalance + parsedAmount : previousBalance - parsedAmount;

  // Generate unique transaction ID
  const transaction_id = `TXN-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  const newTx = await tx.officerTransaction.create({
    data: {
      transaction_id,
      officer_id,
      type,
      amount: parsedAmount,
      balance,
      status: status || (type === 'credit' ? 'pending' : 'paid'),
      description,
      payment_method,
      order_ref,
      submission_ref
    }
  });

  return newTx;
}

module.exports = { createOfficerTransaction };
