const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');
const {
    getOutletPerformanceSummary, getUnifiedRankings, getDeliveryManagementOverview, syncBadges, getBadges,
    getOutletRankings, getMissedRecoveryTracking, getProductSalesReport, getInstallmentStatusCounts,
    getAttendanceMonitoring, getPayrollSummary, getOutletStaffList,
} = require('../controllers/adminPanelController');
const { sendBroadcast, getRoleOptions } = require('../controllers/broadcastController');

router.get('/outlets/performance', authenticateJWT, getOutletPerformanceSummary);
router.get('/outlets/rankings', authenticateJWT, getOutletRankings);
router.get('/rankings', authenticateJWT, getUnifiedRankings);
router.get('/delivery-overview', authenticateJWT, getDeliveryManagementOverview);
router.post('/notifications/broadcast', authenticateJWT, sendBroadcast);
router.get('/roles', authenticateJWT, getRoleOptions);
router.post('/badges/sync', authenticateJWT, syncBadges);
router.get('/badges', authenticateJWT, getBadges);
router.get('/recovery/missed', authenticateJWT, getMissedRecoveryTracking);
router.get('/reports/product-sales', authenticateJWT, getProductSalesReport);
router.get('/installments/status-counts', authenticateJWT, getInstallmentStatusCounts);
router.get('/attendance', authenticateJWT, getAttendanceMonitoring);
router.get('/reports/payroll', authenticateJWT, getPayrollSummary);
router.get('/outlets/staff', authenticateJWT, getOutletStaffList);

module.exports = router;
