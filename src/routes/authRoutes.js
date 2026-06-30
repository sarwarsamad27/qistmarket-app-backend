const express = require('express');
const router = express.Router();
const upload = require('../middlewares/uploadMiddleware');
const fixUploadPath = require('../middlewares/fixUploadPath');

const {
  sendLoginOTP,
  verifyLoginOTP,
  signup,
  toggleUserStatus,
  getUsers,
  editUser,
  updateUserPermissions,
  deleteUser,
  getMe,
  updateProfile,
  getVerificationOfficers,
  getDeliveryOfficers,
  getRecoveryOfficers,
  sendWebLoginOTP,
  verifyWebLoginOTP,
  getDeviceLoginRequest,
  respondDeviceLoginRequest,
  logoutUser
} = require('../controllers/authController');

const { authenticateJWT, requireSuperAdmin } = require('../middlewares/authMiddleware');

// ==================== PUBLIC ROUTES ====================

// Device request routing
router.get('/device-login-requests/:id', getDeviceLoginRequest);

// OTP Web Login Routes
router.post('/login/web/send-otp', sendWebLoginOTP);    // Step 1: Send OTP for Web
router.post('/login/web/verify-otp', verifyWebLoginOTP); // Step 2: Verify OTP & Login for Web
// OTP Login Routes for App (existing)
router.post('/login/send-otp', sendLoginOTP);        // Step 1: Send OTP
router.post('/login/verify-otp', verifyLoginOTP);    // Step 2: Verify OTP & Login

// ==================== PROTECTED ROUTES ====================

router.post('/logout', authenticateJWT, logoutUser);
router.post('/device-login-requests/:id/respond', authenticateJWT, respondDeviceLoginRequest);

// User profile routes
router.get('/user/me', authenticateJWT, getMe);
router.post(
  '/user/update',
  authenticateJWT,
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'coverImage', maxCount: 1 }]),
  fixUploadPath,
  updateProfile
);

// Utility routes
router.get('/users/verification-officers', authenticateJWT, getVerificationOfficers);
router.get('/users/delivery-officers', authenticateJWT, getDeliveryOfficers);
router.get('/users/recovery-officers', authenticateJWT, getRecoveryOfficers);

// ==================== SUPER ADMIN ROUTES ====================

router.post('/signup', authenticateJWT, requireSuperAdmin, signup);
router.get('/users', authenticateJWT, requireSuperAdmin, getUsers);
router.patch('/users/:userId/status', authenticateJWT, requireSuperAdmin, toggleUserStatus);
router.patch(
  '/users/:userId/edit',
  authenticateJWT,
  requireSuperAdmin,
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'coverImage', maxCount: 1 }]),
  fixUploadPath,
  editUser
);
router.patch('/users/:userId/permissions', authenticateJWT, requireSuperAdmin, updateUserPermissions);
router.delete('/users/:userId', authenticateJWT, requireSuperAdmin, deleteUser);


module.exports = router;