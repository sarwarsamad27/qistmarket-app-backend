const prisma = require('../../lib/prisma');
const { logAction } = require('../utils/auditLogger');

const getBankAccounts = async (req, res) => {
    try {
        const { outletId } = req.query;
        const where = {};
        if (outletId && outletId !== 'all') where.outlet_id = parseInt(outletId);

        const accounts = await prisma.bankAccount.findMany({
            where,
            include: { outlet: { select: { id: true, name: true } } },
            orderBy: { created_at: 'desc' },
        });

        res.json({ success: true, data: accounts });
    } catch (error) {
        console.error('getBankAccounts error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getBankBalanceSummary = async (req, res) => {
    try {
        const accounts = await prisma.bankAccount.findMany({
            where: { is_active: true },
            include: { outlet: { select: { id: true, name: true } } },
        });

        const totalBalance = accounts.reduce((acc, a) => acc + a.current_balance, 0);

        res.json({
            success: true,
            data: {
                totalBalance,
                accountCount: accounts.length,
                bankWise: accounts.map((a) => ({
                    id: a.id,
                    bank_name: a.bank_name,
                    account_title: a.account_title,
                    account_number: a.account_number,
                    outlet_name: a.outlet?.name || 'Head Office',
                    current_balance: a.current_balance,
                })),
            },
        });
    } catch (error) {
        console.error('getBankBalanceSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const createBankAccount = async (req, res) => {
    try {
        const { bank_name, account_title, account_number, iban, branch_code, outlet_id, opening_balance, notes } = req.body;

        if (!bank_name || !account_title || !account_number) {
            return res.status(400).json({ success: false, message: 'Bank name, account title, and account number are required.' });
        }

        const opening = parseFloat(opening_balance) || 0;

        const account = await prisma.bankAccount.create({
            data: {
                bank_name,
                account_title,
                account_number,
                iban: iban || null,
                branch_code: branch_code || null,
                outlet_id: outlet_id ? parseInt(outlet_id) : null,
                opening_balance: opening,
                current_balance: opening,
                notes: notes || null,
                created_by_id: req.user.id,
            },
        });

        await logAction(req, 'BANK_ACCOUNT_CREATED', `Bank account ${account.bank_name} (${account.account_number}) created with opening balance PKR ${opening}.`, account.id, 'BankAccount');

        res.status(201).json({ success: true, data: account });
    } catch (error) {
        if (error.code === 'P2002') {
            return res.status(409).json({ success: false, message: 'An account with this account number already exists.' });
        }
        console.error('createBankAccount error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const updateBankAccount = async (req, res) => {
    try {
        const { id } = req.params;
        const { bank_name, account_title, iban, branch_code, outlet_id, notes, is_active } = req.body;

        const account = await prisma.bankAccount.update({
            where: { id: parseInt(id) },
            data: {
                ...(bank_name !== undefined && { bank_name }),
                ...(account_title !== undefined && { account_title }),
                ...(iban !== undefined && { iban }),
                ...(branch_code !== undefined && { branch_code }),
                ...(outlet_id !== undefined && { outlet_id: outlet_id ? parseInt(outlet_id) : null }),
                ...(notes !== undefined && { notes }),
                ...(is_active !== undefined && { is_active }),
            },
        });

        res.json({ success: true, data: account });
    } catch (error) {
        console.error('updateBankAccount error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getBankAccountLedger = async (req, res) => {
    try {
        const { id } = req.params;
        const account = await prisma.bankAccount.findUnique({ where: { id: parseInt(id) }, include: { outlet: { select: { name: true } } } });
        if (!account) return res.status(404).json({ success: false, message: 'Bank account not found.' });

        const transactions = await prisma.bankTransaction.findMany({
            where: { bank_account_id: parseInt(id) },
            include: { created_by: { select: { full_name: true } } },
            orderBy: { transaction_date: 'desc' },
        });

        res.json({ success: true, data: { account, transactions } });
    } catch (error) {
        console.error('getBankAccountLedger error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const recordBankTransaction = async (req, res) => {
    try {
        const { bank_account_id, type, amount, description, reference, transaction_date } = req.body;

        if (!bank_account_id || !['credit', 'debit'].includes(type) || !amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'bank_account_id, a valid type (credit/debit), and a positive amount are required.' });
        }

        const parsedAmount = parseFloat(amount);

        const result = await prisma.$transaction(async (tx) => {
            const account = await tx.bankAccount.findUnique({ where: { id: parseInt(bank_account_id) } });
            if (!account) throw new Error('Bank account not found.');

            const balanceAfter = type === 'credit' ? account.current_balance + parsedAmount : account.current_balance - parsedAmount;

            const transaction = await tx.bankTransaction.create({
                data: {
                    bank_account_id: parseInt(bank_account_id),
                    type,
                    amount: parsedAmount,
                    balance_after: balanceAfter,
                    description: description || null,
                    reference: reference || null,
                    transaction_date: transaction_date ? new Date(transaction_date) : new Date(),
                    created_by_id: req.user.id,
                },
            });

            await tx.bankAccount.update({ where: { id: account.id }, data: { current_balance: balanceAfter } });

            return { transaction, account: { ...account, current_balance: balanceAfter } };
        });

        await logAction(req, 'BANK_TRANSACTION', `${type === 'credit' ? 'Deposit of' : 'Withdrawal of'} PKR ${parsedAmount} recorded on bank account #${bank_account_id}.`, result.transaction.id, 'BankTransaction');

        res.status(201).json({ success: true, data: result });
    } catch (error) {
        console.error('recordBankTransaction error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};

/**
 * uploadBankStatement
 * Stores an uploaded statement file (reuses the same multer-local +
 * /uploads static pattern as hrDocumentController.uploadEmployeeDocument)
 * against a bank account for later reconciliation.
 */
const uploadBankStatement = async (req, res) => {
    try {
        const { bank_account_id, period_start, period_end } = req.body;
        if (!bank_account_id) return res.status(400).json({ success: false, message: 'bank_account_id is required.' });
        if (!req.file) return res.status(400).json({ success: false, message: 'Statement file is required.' });

        const statement = await prisma.bankStatement.create({
            data: {
                bank_account_id: parseInt(bank_account_id),
                file_url: `/uploads/${req.file.filename}`,
                period_start: period_start ? new Date(period_start) : null,
                period_end: period_end ? new Date(period_end) : null,
                uploaded_by_id: req.user.id,
            },
        });

        await logAction(req, 'BANK_STATEMENT_UPLOADED', `Statement uploaded for bank account #${bank_account_id}.`, statement.id, 'BankStatement');

        res.status(201).json({ success: true, data: statement });
    } catch (error) {
        console.error('uploadBankStatement error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getBankStatements = async (req, res) => {
    try {
        const { bank_account_id } = req.query;
        const where = {};
        if (bank_account_id) where.bank_account_id = parseInt(bank_account_id);

        const statements = await prisma.bankStatement.findMany({
            where,
            include: {
                uploaded_by: { select: { full_name: true } },
                _count: { select: { transactions: true } },
            },
            orderBy: { created_at: 'desc' },
        });

        res.json({ success: true, data: statements });
    } catch (error) {
        console.error('getBankStatements error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * reconcileTransactions
 * Marks one or more transactions as reconciled against an uploaded
 * statement — the accountant manually matches lines, this just persists
 * the match (no automated statement-parsing, which would need a specific
 * bank file format to build against).
 */
const reconcileTransactions = async (req, res) => {
    try {
        const { transaction_ids, statement_id } = req.body;
        if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
            return res.status(400).json({ success: false, message: 'transaction_ids array is required.' });
        }

        await prisma.bankTransaction.updateMany({
            where: { id: { in: transaction_ids.map((id) => parseInt(id)) } },
            data: { reconciled: true, statement_id: statement_id ? parseInt(statement_id) : null },
        });

        await logAction(req, 'BANK_RECONCILIATION', `${transaction_ids.length} transaction(s) marked reconciled.`, statement_id ? parseInt(statement_id) : null, 'BankStatement');

        res.json({ success: true, message: `${transaction_ids.length} transaction(s) reconciled.` });
    } catch (error) {
        console.error('reconcileTransactions error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getReconciliationStatus
 * Per-account reconciled vs unreconciled transaction totals, so the UI
 * can show how much of each account's ledger has been matched to a statement.
 */
const getReconciliationStatus = async (req, res) => {
    try {
        const { bank_account_id } = req.params;
        const transactions = await prisma.bankTransaction.findMany({
            where: { bank_account_id: parseInt(bank_account_id) },
            select: { id: true, amount: true, type: true, reconciled: true, transaction_date: true, description: true },
            orderBy: { transaction_date: 'desc' },
        });

        const reconciled = transactions.filter((t) => t.reconciled);
        const unreconciled = transactions.filter((t) => !t.reconciled);

        res.json({
            success: true,
            data: {
                reconciledCount: reconciled.length,
                unreconciledCount: unreconciled.length,
                unreconciledTotal: unreconciled.reduce((acc, t) => acc + (t.type === 'credit' ? t.amount : -t.amount), 0),
                unreconciled,
            },
        });
    } catch (error) {
        console.error('getReconciliationStatus error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * createInterBankTransfer
 * Atomically records a debit on the source account and a credit on the
 * destination account, linked by a shared transfer_group reference.
 */
const createInterBankTransfer = async (req, res) => {
    try {
        const { from_account_id, to_account_id, amount, description, transaction_date } = req.body;

        if (!from_account_id || !to_account_id || from_account_id === to_account_id) {
            return res.status(400).json({ success: false, message: 'from_account_id and to_account_id are required and must differ.' });
        }
        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'A positive amount is required.' });
        }

        const parsedAmount = parseFloat(amount);
        const transferGroup = `TRF-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const txnDate = transaction_date ? new Date(transaction_date) : new Date();

        const result = await prisma.$transaction(async (tx) => {
            const fromAccount = await tx.bankAccount.findUnique({ where: { id: parseInt(from_account_id) } });
            const toAccount = await tx.bankAccount.findUnique({ where: { id: parseInt(to_account_id) } });
            if (!fromAccount || !toAccount) throw new Error('One or both bank accounts were not found.');

            const fromBalanceAfter = fromAccount.current_balance - parsedAmount;
            const toBalanceAfter = toAccount.current_balance + parsedAmount;

            const debitTxn = await tx.bankTransaction.create({
                data: {
                    bank_account_id: fromAccount.id, type: 'debit', amount: parsedAmount, balance_after: fromBalanceAfter,
                    description: description || `Transfer to ${toAccount.bank_name} (${toAccount.account_number})`,
                    transfer_group: transferGroup, transaction_date: txnDate, created_by_id: req.user.id,
                },
            });
            const creditTxn = await tx.bankTransaction.create({
                data: {
                    bank_account_id: toAccount.id, type: 'credit', amount: parsedAmount, balance_after: toBalanceAfter,
                    description: description || `Transfer from ${fromAccount.bank_name} (${fromAccount.account_number})`,
                    transfer_group: transferGroup, transaction_date: txnDate, created_by_id: req.user.id,
                },
            });

            await tx.bankAccount.update({ where: { id: fromAccount.id }, data: { current_balance: fromBalanceAfter } });
            await tx.bankAccount.update({ where: { id: toAccount.id }, data: { current_balance: toBalanceAfter } });

            return { debitTxn, creditTxn, transferGroup };
        });

        await logAction(req, 'BANK_INTER_TRANSFER', `PKR ${parsedAmount} transferred between bank account #${from_account_id} and #${to_account_id}.`, null, 'BankTransaction');

        res.status(201).json({ success: true, data: result });
    } catch (error) {
        console.error('createInterBankTransfer error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};

module.exports = {
    getBankAccounts,
    getBankBalanceSummary,
    createBankAccount,
    updateBankAccount,
    getBankAccountLedger,
    recordBankTransaction,
    uploadBankStatement,
    getBankStatements,
    reconcileTransactions,
    getReconciliationStatus,
    createInterBankTransfer,
};
