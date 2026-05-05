const express = require('express');
const router = express.Router();
const {
  createOrder,
  getOrders,
  getOrdersWithPagination,
  assignOrder,
  assignBulk,
  getOrderById,
  getVerificationOrders,
  getApprovedOrders,
  assignDelivery,
  assignBulkDelivery,
  cancelOrder,
  updateOrderItem,
  getDeliveryStatus,
  getDeliveredOrders,
  assignRecovery,
  assignBulkRecovery,
  getMyDeliveryOrdersWithPagination,
  initiateHandover,
  verifyHandover,
  getOutletDeliveryOfficers,
  getOfficerApprovedOrders,
  getHandoverHistory,
  takeOrder,
  getCsrDashboardStats,
  getExpiredAssignedOrders,
  createOrderFromWebsitePickup,
  getWebsiteOrderFeed,
  transferOrder,
  transferBulk,
  getSelfPickupInventory,
  sendSelfPickupOTP,
  verifySelfPickupOTP,
  sendIndividualConvertOTP,
  verifyConvertSaleOTP,
  createConvertedSale,
} = require('../controllers/ordersController');
const { submitSelfPickupDelivery } = require('../controllers/deliveryController');
const { authenticateJWT } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/uploadMiddleware');
const fixUploadPath = require('../middlewares/fixUploadPath');

// Recovery Related Order Routes (Specific routes first)
router.get('/orders/delivered-list', authenticateJWT, getDeliveredOrders);
router.patch('/orders/:id/assign-recovery', authenticateJWT, assignRecovery);
router.post('/orders/assign-bulk-recovery', authenticateJWT, assignBulkRecovery);

// Standard Order Routes
router.get('/orders/verification-pending', getVerificationOrders);
router.get('/orders/delivery-pending', authenticateJWT, getApprovedOrders);
router.get('/orders/delivery-status', authenticateJWT, getDeliveryStatus);
router.post('/orders/create', authenticateJWT, createOrder);
router.get('/orders', authenticateJWT, getOrders);
router.get('/orders/csr-dashboard-stats', authenticateJWT, getCsrDashboardStats);
router.post('/orders/website-pickup', authenticateJWT, createOrderFromWebsitePickup);
router.get('/orders/website-feed', authenticateJWT, getWebsiteOrderFeed);
router.get('/orders/expired/assigned', authenticateJWT, getExpiredAssignedOrders);
router.get('/orders/scroll', authenticateJWT, getOrdersWithPagination);
router.get('/orders/deliver/scroll', authenticateJWT, getMyDeliveryOrdersWithPagination);
router.patch('/orders/:id/assign', authenticateJWT, assignOrder);
router.post('/orders/assign-bulk', authenticateJWT, assignBulk);
router.get('/orders/:id', authenticateJWT, getOrderById);
router.patch('/orders/:id/assign-delivery', authenticateJWT, assignDelivery);
router.post('/orders/assign-bulk-delivery', authenticateJWT, assignBulkDelivery);
router.patch('/orders/:id/cancel', authenticateJWT, cancelOrder);
router.patch('/orders/:id/update-item', authenticateJWT, updateOrderItem);
router.patch('/orders/:id/take', authenticateJWT, takeOrder);
router.patch('/orders/:id/transfer', authenticateJWT, transferOrder);
router.post('/orders/transfer-bulk', authenticateJWT, transferBulk);

// Self Pickup Routes
router.get('/orders/self-pickup/inventory', authenticateJWT, getSelfPickupInventory);
router.post('/orders/self-pickup/send-otp', authenticateJWT, sendSelfPickupOTP);
router.post('/orders/self-pickup/verify-otp', authenticateJWT, verifySelfPickupOTP);
router.post('/orders/self-pickup/submit', authenticateJWT, upload.fields([{ name: 'face_photo', maxCount: 1 }]), fixUploadPath, submitSelfPickupDelivery);

// Handover Routes
router.post('/orders/:id/initiate-handover', authenticateJWT, initiateHandover);
router.post('/orders/:id/verify-handover', authenticateJWT, verifyHandover);

// Convert Cleared Account Routes
router.post('/orders/convert/send-otp', authenticateJWT, sendIndividualConvertOTP);
router.post('/orders/convert/verify-otp', authenticateJWT, verifyConvertSaleOTP);
router.post('/orders/convert/create', authenticateJWT, createConvertedSale);

// Outlet Handover Management
router.get('/orders/handover/history', authenticateJWT, getHandoverHistory);
router.get('/orders/outlet/officers', authenticateJWT, getOutletDeliveryOfficers);
router.get('/orders/outlet/officers/:officerId/approved', authenticateJWT, getOfficerApprovedOrders);

module.exports = router;
