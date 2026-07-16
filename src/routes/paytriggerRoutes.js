const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');
const {
  enrollDevice,
  getDeviceStatus,
  syncDeviceStatus,
  manualLock,
  manualUnlock,
  promiseToPay,
  handleCallback,
  listDevices,
  getDeviceSummary,
  syncAllDevices,
  getDeviceTagRemote,
  unenrollDevice,
  tempUnlockDevice,
  setDeviceRule,
  sendDevicePush,
  getDeviceOfflinePin,
  updateDeviceRepayInfo,
  findPhoneSubmit,
  findPhoneClose,
  findPhoneStatus,
  resetDeviceSimLock,
  getCompanyConfig,
  updateCompanyRule,
  checkCompanyLicense,
} = require('../controllers/paytriggerController');

router.post('/paytrigger/enroll', authenticateJWT, enrollDevice);
router.post('/paytrigger/callback', handleCallback);
router.get('/paytrigger/device/:imei/status', authenticateJWT, getDeviceStatus);
router.get('/paytrigger/device/:imei/tag', authenticateJWT, getDeviceTagRemote);
router.post('/paytrigger/device/:imei/sync', authenticateJWT, syncDeviceStatus);
router.post('/paytrigger/device/:imei/lock', authenticateJWT, manualLock);
router.post('/paytrigger/device/:imei/unlock', authenticateJWT, manualUnlock);
router.post('/paytrigger/device/:imei/ptp', authenticateJWT, promiseToPay);
router.post('/paytrigger/device/:imei/unenroll', authenticateJWT, unenrollDevice);
router.post('/paytrigger/device/:imei/temp-unlock', authenticateJWT, tempUnlockDevice);
router.post('/paytrigger/device/:imei/set-rule', authenticateJWT, setDeviceRule);
router.post('/paytrigger/device/:imei/push', authenticateJWT, sendDevicePush);
router.post('/paytrigger/device/:imei/offline-pin', authenticateJWT, getDeviceOfflinePin);
router.post('/paytrigger/device/:imei/repay-info', authenticateJWT, updateDeviceRepayInfo);
router.post('/paytrigger/device/:imei/find/submit', authenticateJWT, findPhoneSubmit);
router.post('/paytrigger/device/:imei/find/close', authenticateJWT, findPhoneClose);
router.post('/paytrigger/device/:imei/find/status', authenticateJWT, findPhoneStatus);
router.post('/paytrigger/device/:imei/simlock-reset', authenticateJWT, resetDeviceSimLock);

router.get('/paytrigger/devices', authenticateJWT, listDevices);
router.get('/paytrigger/devices/summary', authenticateJWT, getDeviceSummary);
router.post('/paytrigger/sync-all', authenticateJWT, syncAllDevices);

// Global Company Routes
router.get('/paytrigger/company/config', authenticateJWT, getCompanyConfig);
router.get('/paytrigger/company/license', authenticateJWT, checkCompanyLicense);
router.post('/paytrigger/company/lock-rule', authenticateJWT, updateCompanyRule);

module.exports = router;
