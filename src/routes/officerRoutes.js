const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');

const {
  getAllVerificationOfficers,
  getOfficerProfileDetail,
  getAllDeliveryOfficers,
  getDeliveryOfficerProfileDetail,
  getAllRecoveryOfficers,
  getRecoveryOfficerProfileDetail,
  updateOfficerProfile,
  getMyOfficerStatus,
  getOfficerDailyStats,
  getOfficerDashboardStats,
} = require('../controllers/officerController');

// Backward compatibility - /officers returns verification officers
router.get('/officers', authenticateJWT, getAllVerificationOfficers);

// Specific officer types
router.get('/officers/verification', authenticateJWT, getAllVerificationOfficers);
router.get('/officers/delivery', authenticateJWT, getAllDeliveryOfficers);
router.get('/officers/recovery', authenticateJWT, getAllRecoveryOfficers);

// Profile detail endpoints
router.get('/verification/:officerId/profile-detail', authenticateJWT, getOfficerProfileDetail);
router.get('/delivery/:officerId/profile-detail', authenticateJWT, getDeliveryOfficerProfileDetail);
router.get('/recovery/:officerId/profile-detail', authenticateJWT, getRecoveryOfficerProfileDetail);

// Profile updates and status
router.put('/officer/profile', authenticateJWT, updateOfficerProfile);
router.get('/officer/status', authenticateJWT, getMyOfficerStatus);
router.get('/officers/:id/stats', authenticateJWT, getOfficerDailyStats);

// Unified Dashboard for all officers
router.get('/officer/dashboard', authenticateJWT, getOfficerDashboardStats);

module.exports = router;