const express = require('express');
const router = express.Router();
const upload = require('../middlewares/uploadMiddleware');
const fixUploadPath = require('../middlewares/fixUploadPath');
const { authenticateJWT } = require('../middlewares/authMiddleware');

const {
  submitDelivery,
  getDeliveryByOrderId,
  getPendingDeliveryProducts,
  getCashInHand,
  generateDeliveryOtp,
  verifyDeliveryOtp,
  returnProduct,
  generateRefundOtp,
  verifyRefundOtp,
  getDeliveryBoyInventory,
  // pickOrder,
  unpickOrder,
  submitCashToOutlet,
  initiateReturnExchange,
  getDeliveryOfficerOTPLogs,
  replaceDeliveryUpload
} = require('../controllers/deliveryController');

// Delivery Officer Analytics
const { getDeliveryOfficerAnalytics } = require('../controllers/deliveryAnalyticsController');

// Submit delivery (batch)
router.post(
  '/delivery/submit',
  authenticateJWT,
  upload.fields([
    { name: 'face_photos', maxCount: 5 },
    { name: 'location_photos', maxCount: 5 },
    { name: 'house_photos', maxCount: 5 }
  ]),
  fixUploadPath,
  submitDelivery
);

// Get delivery by order ID
router.get('/delivery/order/:order_id', getDeliveryByOrderId);
router.get('/delivery-boy/picked-products-minimal', authenticateJWT, getPendingDeliveryProducts);
router.get('/delivery-boy/cash-in-hand', authenticateJWT, getCashInHand);
router.get('/delivery-boy/inventory', authenticateJWT, getDeliveryBoyInventory);

// OTP Verified Delivery Flows
router.post('/delivery/generate-otp', authenticateJWT, generateDeliveryOtp);
router.post('/delivery/verify-otp', authenticateJWT, verifyDeliveryOtp);
router.post('/delivery/return', authenticateJWT, returnProduct);
router.get('/delivery/otp-logs', authenticateJWT, getDeliveryOfficerOTPLogs);

// OTP Verified Refund Flows
router.post('/delivery/refund/generate-otp', authenticateJWT, generateRefundOtp);
router.post('/delivery/refund/verify-otp', authenticateJWT, verifyRefundOtp);

// Pick/Unpick Order Status
// router.post('/delivery/pick-order', authenticateJWT, pickOrder);
router.post('/delivery/unpick-order', authenticateJWT, unpickOrder);

// Cash handling routes
router.post('/delivery-boy/submit-cash', authenticateJWT, submitCashToOutlet);

// Return / Exchange initiate
router.post('/delivery-boy/initiate-return', authenticateJWT, initiateReturnExchange);

// Analytics & Reporting for Delivery Officer
router.get('/delivery-boy/analytics', authenticateJWT, getDeliveryOfficerAnalytics);

// Replace delivery upload photo (Super Admin only)
router.put(
  '/delivery/upload/:upload_id/replace',
  authenticateJWT,
  upload.single('file'),
  fixUploadPath,
  replaceDeliveryUpload
);

module.exports = router;