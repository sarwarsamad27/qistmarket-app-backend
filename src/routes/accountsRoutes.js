const express = require('express');
const { authenticateJWT } = require('../middlewares/authMiddleware');
const { requireAccountant } = require('../middlewares/accountsAuthMiddleware');
const { accountantLogin } = require('../controllers/accountsAuthController');
const {
  getCashInHandOverview,
  getGlobalExpenseSummary,
  getGlobalVendorPayables,
  getRecoveryAnalytics,
  getDashboardSummary,
  getInstallmentAging,
  getOnlinePaymentsOverview,
  getMonthlyInstallmentAnalytics,
  setMonthlyTarget,
  getInstallmentFlowAnalytics,
  getChannelWiseRecovery,
  getGlobalAlerts,
  getInstallmentReceivingOverview,
} = require('../controllers/accountsController');
const {
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
} = require('../controllers/bankAccountController');
const upload = require('../middlewares/uploadMiddleware');
const { getBlacklistedCustomers } = require('../controllers/customerController');
const {
  searchByCnicOrPhone,
  setBlacklistStatus,
  approveBlacklistAction,
  rejectBlacklistAction,
  getPendingWhitelistRequests,
  getCustomerRiskScore,
  getBlacklistHistory,
  triggerSync,
} = require('../controllers/blacklistController');
const { getSecurityLogs } = require('../controllers/securityLogController');
const {
  getCashReports,
  getCashSubmissionHistory,
  getCashLimits,
  setCashLimit,
  deleteCashLimit,
} = require('../controllers/accountsCashController');
const {
  createHeadOfficeExpense,
  getExpenseApprovalQueue,
  decideExpenseApproval,
  uploadExpenseInvoice,
  getSalaryExpenses,
} = require('../controllers/accountsExpenseController');
const {
  createHeadOfficeVendor,
  recordVendorCashTransaction,
  getVendorCashLedger,
  getVendorAgingReport,
  getVendorDueAlerts,
  createScheduledPayment,
  getScheduledPayments,
  updateScheduledPaymentStatus,
} = require('../controllers/accountsVendorController');
const {
  getCustomerPaymentSchedule,
  getReceivablesRiskAnalysis,
} = require('../controllers/accountsReceivablesController');
const {
  getLoginHistory,
  getFraudAlerts,
} = require('../controllers/accountsAuditController');
const {
  getWarehouseStockSummary,
  getStockTransfersOverview,
  getReturnItemsReport,
  searchByImei,
} = require('../controllers/accountsStockController');
const {
  exportReportCsv,
  createScheduledReport,
  getScheduledReports,
  toggleScheduledReport,
  deleteScheduledReport,
} = require('../controllers/accountsReportController');

const router = express.Router();

// Public route: Accountant login
router.post('/login', accountantLogin);

// Protected Accounts routes
router.use(authenticateJWT, requireAccountant);

router.get('/dashboard-summary', getDashboardSummary);
router.get('/cash-in-hand', getCashInHandOverview);
router.get('/expenses/summary', getGlobalExpenseSummary);
router.get('/vendors/payables', getGlobalVendorPayables);
router.get('/recovery-analytics', getRecoveryAnalytics);
router.get('/aging', getInstallmentAging);
router.get('/online-payments', getOnlinePaymentsOverview);
router.get('/monthly-installments', getMonthlyInstallmentAnalytics);
router.post('/monthly-installments/target', setMonthlyTarget);
router.get('/installment-flow', getInstallmentFlowAnalytics);
router.get('/recovery-analytics/channel-wise', getChannelWiseRecovery);
router.get('/alerts', getGlobalAlerts);
router.get('/installment-receiving', getInstallmentReceivingOverview);

// Bank Accounts
router.get('/bank-accounts', getBankAccounts);
router.get('/bank-accounts/summary', getBankBalanceSummary);
router.post('/bank-accounts', createBankAccount);
router.patch('/bank-accounts/:id', updateBankAccount);
router.get('/bank-accounts/:id/ledger', getBankAccountLedger);
router.post('/bank-accounts/transactions', recordBankTransaction);
router.post('/bank-accounts/transfer', createInterBankTransfer);
router.post('/bank-accounts/statements', upload.single('file'), uploadBankStatement);
router.get('/bank-accounts/statements', getBankStatements);
router.post('/bank-accounts/reconcile', reconcileTransactions);
router.get('/bank-accounts/:bank_account_id/reconciliation-status', getReconciliationStatus);

// Blacklist / Whitelist Management
router.get('/blacklist', getBlacklistedCustomers);
router.get('/blacklist/search', searchByCnicOrPhone);
router.post('/blacklist/action', setBlacklistStatus);
router.get('/blacklist/history', getBlacklistHistory);
router.post('/blacklist/sync', triggerSync);
router.get('/blacklist/pending-whitelist', getPendingWhitelistRequests);
router.post('/blacklist/:id/approve', approveBlacklistAction);
router.post('/blacklist/:id/reject', rejectBlacklistAction);
router.get('/blacklist/risk-score/:cnic', getCustomerRiskScore);

// Global Activity Log
router.get('/activity-logs', getSecurityLogs);

// Cash Management (reports, submission history, limits)
router.get('/cash/reports', getCashReports);
router.get('/cash/submission-history', getCashSubmissionHistory);
router.get('/cash/limits', getCashLimits);
router.post('/cash/limits', setCashLimit);
router.delete('/cash/limits/:id', deleteCashLimit);

// Expense Management (HO expenses, approvals, invoices, salary link)
router.post('/expenses', createHeadOfficeExpense);
router.get('/expenses/approvals', getExpenseApprovalQueue);
router.post('/expenses/:id/decision', decideExpenseApproval);
router.post('/expenses/:id/invoice', upload.single('file'), uploadExpenseInvoice);
router.get('/expenses/salary', getSalaryExpenses);

// Vendors (HO creation, vendor cash-in-hand, aging, alerts, scheduling)
router.post('/vendors', createHeadOfficeVendor);
router.post('/vendors/cash-transactions', recordVendorCashTransaction);
router.get('/vendors/:vendor_id/cash-ledger', getVendorCashLedger);
router.get('/vendors/aging', getVendorAgingReport);
router.get('/vendors/due-alerts', getVendorDueAlerts);
router.post('/vendors/scheduled-payments', createScheduledPayment);
router.get('/vendors/scheduled-payments', getScheduledPayments);
router.patch('/vendors/scheduled-payments/:id', updateScheduledPaymentStatus);

// Receivables (payment schedules, risk analysis)
router.get('/receivables/schedule/:order_id', getCustomerPaymentSchedule);
router.get('/receivables/risk-analysis', getReceivablesRiskAnalysis);

// Audit: login history + fraud monitoring
router.get('/audit/login-history', getLoginHistory);
router.get('/audit/fraud-alerts', getFraudAlerts);

// Stock: warehouse, transfers, returns, IMEI search
router.get('/stock/warehouse', getWarehouseStockSummary);
router.get('/stock/transfers', getStockTransfersOverview);
router.get('/stock/returns', getReturnItemsReport);
router.get('/stock/imei/:imei', searchByImei);

// Reporting: CSV export + scheduled report config
router.get('/reports/export/:reportType', exportReportCsv);
router.post('/reports/scheduled', createScheduledReport);
router.get('/reports/scheduled', getScheduledReports);
router.patch('/reports/scheduled/:id', toggleScheduledReport);
router.delete('/reports/scheduled/:id', deleteScheduledReport);

module.exports = router;
