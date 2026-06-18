const express = require('express');
const router = express.Router();
const {
    createOutlet,
    getOutlets,
    getAllOutlets,
    updateOutlet,
    loginOutletUser,
    getDashboardStats,
    getGlobalCashInHand,
    verifyCashSubmissionOTP,
    getOutletCashHistory,
    getReturnExchanges,
    verifyReturnExchangeOtp,
    initiateDirectReturn,
    searchDeliveredOrders,
    getOutletInstallments,
    generateInstallmentOtp,
    verifyInstallmentPayment,
    getOutletOfficers,
    getOfficerDetails,
    getOutletInstallmentsDueList,
    updateInstallmentNote,
    getPendingCashSubmissions,
    resendCashSubmissionOTP
} = require('../controllers/outletController');
const { generateSmartPayQr, checkSmartPayQr } = require('../controllers/smartPayController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.post('/outlets', authenticateJWT, createOutlet);
router.get('/outlets', authenticateJWT, getOutlets);
router.get('/all-outlets', authenticateJWT, getAllOutlets);
router.patch('/outlets/:id', authenticateJWT, updateOutlet);
router.post('/outlet/login', loginOutletUser);
router.get('/outlet/dashboard-stats', authenticateJWT, getDashboardStats);

// Cash handling routes
router.post('/outlet/verify-cash-otp', authenticateJWT, verifyCashSubmissionOTP);
router.get('/outlet/global-cash-in-hand', authenticateJWT, getGlobalCashInHand);
router.get('/outlet/cash-history', authenticateJWT, getOutletCashHistory);
router.get('/outlet/pending-cash-submissions', authenticateJWT, getPendingCashSubmissions);
router.post('/outlet/resend-cash-otp', authenticateJWT, resendCashSubmissionOTP);

// Return and Exchange Module
router.get('/outlet/return-exchanges', authenticateJWT, getReturnExchanges);
router.post('/outlet/verify-return-otp', authenticateJWT, verifyReturnExchangeOtp);
router.get('/outlet/search-delivered-orders', authenticateJWT, searchDeliveredOrders);
router.post('/outlet/initiate-direct-return', authenticateJWT, initiateDirectReturn);
router.get('/outlet/installments', authenticateJWT, getOutletInstallments);
router.get('/outlet/installments/due-list', authenticateJWT, getOutletInstallmentsDueList);
router.patch('/outlet/installments/:id/note', authenticateJWT, updateInstallmentNote);

// Installment Payment flows (Outlet Managers)
router.post('/outlet/installment/generate-otp', authenticateJWT, generateInstallmentOtp);
router.post('/outlet/installment/verify-and-pay', authenticateJWT, verifyInstallmentPayment);
router.post('/outlet/installment/generate-smartpay-qr', authenticateJWT, generateSmartPayQr);
router.get('/outlet/installment/check-smartpay-qr', authenticateJWT, checkSmartPayQr);

// Team Management (Delivery/Recovery Officers)
router.get('/outlet/team/list', authenticateJWT, getOutletOfficers);
router.get('/outlet/team/details/:id', authenticateJWT, getOfficerDetails);

// Auto-Assignment Settings
const { getAutoAssignmentSettings, updateAutoAssignmentSettings } = require('../controllers/settingsController');
router.get('/outlet/auto-assignment-settings', authenticateJWT, getAutoAssignmentSettings);
router.post('/outlet/auto-assignment-settings', authenticateJWT, updateAutoAssignmentSettings);

module.exports = router;
