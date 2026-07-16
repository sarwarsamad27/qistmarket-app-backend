const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');
const {
    getDaybook,
    getStockSummary,
    getSalesReport,
    getProfitLoss,
    getCustomerLedger,
    getRecoveryReport,
    getAllOutlets,
    getFinancialReport,
    getInstallmentRecoveriesReport,
    getOfficerRecoveryReport
} = require('../controllers/outletReportController');

// All routes require authentication
router.use(authenticateJWT);

/**
 * @route   GET /api/outlet-reports/daybook
 * @desc    Get daily transactions (income/expense)
 */
router.get('/outlet-reports/daybook', getDaybook);

/**
 * @route   GET /api/outlet-reports/stock-summary
 * @desc    Get summary of items in stock
 */
router.get('/outlet-reports/stock-summary', getStockSummary);

/**
 * @route   GET /api/outlet-reports/sales
 * @desc    Get detailed sales report
 */
router.get('/outlet-reports/sales', getSalesReport);

/**
 * @route   GET /api/outlet-reports/profit-loss
 * @desc    Get Profit & Loss calculation
 */
router.get('/outlet-reports/profit-loss', getProfitLoss);

/**
 * @route   GET /api/outlet-reports/customer-ledger/:phone
 * @desc    Get transaction history for a specific customer
 */
router.get('/outlet-reports/customer-ledger/:phone', getCustomerLedger);

/**
 * @route   GET /api/outlet-reports/recovery
 * @desc    Get recovery/pending payments report
 */
router.get('/outlet-reports/recovery', getRecoveryReport);

/**
 * @route   GET /api/outlet-reports/all-outlets
 * @desc    Simple outlet list helper for admin/outlet-selector dropdowns
 */
router.get('/outlet-reports/all-outlets', getAllOutlets);

/**
 * @route   GET /api/outlet-reports/financials
 * @desc    Get comprehensive financials (Expenses + Vendor Payments)
 */
router.get('/outlet-reports/financials', getFinancialReport);

/**
 * @route   GET /api/outlet-reports/installment-recoveries
 * @desc    Get strictly the cash collected from installments
 */
router.get('/outlet-reports/installment-recoveries', getInstallmentRecoveriesReport);

/**
 * @route   GET /api/outlet-reports/officer-recoveries
 * @desc    Get performance and collections of recovery officers
 */
router.get('/outlet-reports/officer-recoveries', getOfficerRecoveryReport);

module.exports = router;
