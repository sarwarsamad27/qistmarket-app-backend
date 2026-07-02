const express = require('express');
const router = express.Router();
const upload = require('../config/multer-local');
const fixUploadPath = require('../middlewares/fixUploadPath');
const {
  getAllRecoveryOfficers,
  getRecoveryOfficerStats,
  getRecoveryCustomers,
  getCollectionStats,
  getDueOverdueInstallments,
  submitCollections,
  generateInstallmentOtp,
  submitInstallment,
  logRecoveryVisit,
  getOrderRecoveryVisits,
  replaceRecoveryVisitPhoto,
  getRecoveryDashboardStats,
  getRecoveryFuelCharges,
  getRecoveryCollectedPayments,
  getRecoveryVisits,
  getRecoveryPtpList
} = require('../controllers/recoveryController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/dashboard-stats', authenticateJWT, getRecoveryDashboardStats);
router.get('/fuel-charges', authenticateJWT, getRecoveryFuelCharges);
router.get('/collected-payments', authenticateJWT, getRecoveryCollectedPayments);
router.get('/visits', authenticateJWT, getRecoveryVisits);
router.get('/ptp', authenticateJWT, getRecoveryPtpList);
router.get('/officers', authenticateJWT, getAllRecoveryOfficers);
router.get('/officers/:id/stats', authenticateJWT, getRecoveryOfficerStats);

// Collection Routes
router.get('/customers', authenticateJWT, getRecoveryCustomers);
router.get('/collection-stats', authenticateJWT, getCollectionStats);
router.get('/overdue', authenticateJWT, getDueOverdueInstallments);
router.post('/submit-collections', authenticateJWT, submitCollections);

// Installment Payment flows (Recovery Officers) — with file uploads (up to 5 images)
router.post('/installment/generate-otp', authenticateJWT, generateInstallmentOtp);
router.post(
  '/submit-installment',
  authenticateJWT,
  upload.fields([
    { name: 'visit_photos', maxCount: 5 },
    { name: 'profile_photo', maxCount: 5 }
  ]),
  fixUploadPath,
  submitInstallment
);

// Visit Logging Route (without payment) — with file uploads (up to 5 images)
router.post(
  '/visit',
  authenticateJWT,
  upload.fields([
    { name: 'visit_photos', maxCount: 5 },
    { name: 'profile_photo', maxCount: 5 }
  ]),
  fixUploadPath,
  logRecoveryVisit
);

// recoveryRoutes.js - Add this route
router.get('/order/:order_id/visits', authenticateJWT, getOrderRecoveryVisits);

// Replace recovery visit photo (Super Admin only)
router.put(
  '/visit-photo/:photo_id/replace',
  authenticateJWT,
  upload.single('file'),
  fixUploadPath,
  replaceRecoveryVisitPhoto
);

module.exports = router;
