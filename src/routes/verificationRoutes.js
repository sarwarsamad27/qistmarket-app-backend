const express = require('express');
const router = express.Router();
const upload = require('../middlewares/uploadMiddleware');
const fixUploadPath = require('../middlewares/fixUploadPath');
const { authenticateJWT } = require('../middlewares/authMiddleware');

const {
  getVerifications,
  startVerification,
  savePurchaserVerification,
  saveGrantorVerification,
  saveNextOfKin,
  saveLocation,
  saveVerificationLocation,
  getVerificationLocations,
  deleteVerificationLocation,
  uploadPurchaserDocument,
  uploadGrantorDocument,
  uploadPhoto,
  uploadSignature,
  deleteDocument,
  completeVerification,
  getVerificationByOrderId,
  submitVerificationReview,
  getMyPendingOrders,
  getMyConfirmedOrders,
  getMyCancelledOrders,
  getMyCustomersWithOrdersAndLedger,
  updatePurchaserField,
  updateGrantorField,
  getEditHistory,
  sendToVOForLocation,
  sendToDOForLocation,
  updateLocationVerified,
  getDeliveredProductDetails,
  getDeliveredProductsList,
  updateVerificationMedia
} = require('../controllers/verificationController');

// Get all verifications
router.get('/verifications', authenticateJWT, getVerifications);

router.get('/officer/orders/pending', authenticateJWT, getMyPendingOrders);
router.get('/officer/orders/confirmed', authenticateJWT, getMyConfirmedOrders);
router.get('/officer/orders/cancelled', authenticateJWT, getMyCancelledOrders);

router.get(
  '/officer/customers',
  authenticateJWT,
  getMyCustomersWithOrdersAndLedger
);

// Start verification
router.post('/verification/start', authenticateJWT, startVerification);

// Get verification by order ID
router.get('/verification/order/:order_id', getVerificationByOrderId);

// Save verification data
router.post('/verification/:verification_id/purchaser', authenticateJWT, savePurchaserVerification);
router.post('/verification/:verification_id/grantor/:grantor_number', authenticateJWT, saveGrantorVerification);
router.post('/verification/:verification_id/next-of-kin', authenticateJWT, saveNextOfKin);

// NEW: Update single field (for editing)
router.put('/verification/:verification_id/purchaser/field', authenticateJWT, updatePurchaserField);
router.put('/verification/:verification_id/grantor/:grantor_id/field', authenticateJWT, updateGrantorField);

// NEW: Get edit history
router.get('/verification/:verification_id/history/:entity_type/:entity_id', authenticateJWT, getEditHistory);

// Save location (old)
router.post('/verification/:verification_id/location', authenticateJWT, saveLocation);

// NEW: Save verification location with photos
router.post(
  '/verification/:verification_id/location/new',
  authenticateJWT,
  upload.array('photos', 5),
  fixUploadPath,
  saveVerificationLocation
);

// NEW: Get verification locations
router.get('/verification/:verification_id/locations', authenticateJWT, getVerificationLocations);

// NEW: Delete verification location
router.delete('/verification/location/:location_id', authenticateJWT, deleteVerificationLocation);

// Upload purchaser document
router.post(
  '/verification/:verification_id/purchaser/document',
  authenticateJWT,
  upload.single('file'),
  fixUploadPath,
  uploadPurchaserDocument
);

// Upload grantor document
router.post(
  '/verification/:verification_id/grantor/:grantor_number/document',
  authenticateJWT,
  upload.single('file'),
  fixUploadPath,
  uploadGrantorDocument
);

// Upload photo
router.post(
  '/verification/:verification_id/photo',
  authenticateJWT,
  upload.single('file'),
  fixUploadPath,
  uploadPhoto
);

// Upload signature
router.post(
  '/verification/:verification_id/signature',
  authenticateJWT,
  upload.single('file'),
  fixUploadPath,
  uploadSignature
);

// Delete document
router.delete('/verification/document/:document_id', authenticateJWT, deleteDocument);

// Complete verification
router.post('/verification/:verification_id/complete', authenticateJWT, completeVerification);

// Submit review (replaces admin approval)
router.post('/verification/:verification_id/approve', authenticateJWT, submitVerificationReview);

// NEW: Location Handling
router.post('/verification/:verification_id/send-to-vo', authenticateJWT, sendToVOForLocation);
router.post('/verification/:verification_id/send-to-do', authenticateJWT, sendToDOForLocation);
router.post(
  '/verification/:verification_id/location-verified',
  authenticateJWT,
  upload.array('photos', 5),
  fixUploadPath,
  updateLocationVerified
);

// NEW: Update verification media
router.put(
  '/verification/:verification_id/media',
  authenticateJWT,
  upload.single('file'),
  fixUploadPath,
  updateVerificationMedia
);


router.get('/delivered-product/order/:order_id', authenticateJWT, getDeliveredProductDetails);

// Get list of all delivered products (with pagination and search)
router.get('/delivered-products', authenticateJWT, getDeliveredProductsList);

module.exports = router;