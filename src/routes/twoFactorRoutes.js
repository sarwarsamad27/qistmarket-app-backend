const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');
const { generate2FASecret, verify2FASetup, disable2FA, get2FAStatus } = require('../controllers/twoFactorController');

router.get('/status', authenticateJWT, get2FAStatus);
router.post('/generate', authenticateJWT, generate2FASecret);
router.post('/verify', authenticateJWT, verify2FASetup);
router.post('/disable', authenticateJWT, disable2FA);

module.exports = router;
