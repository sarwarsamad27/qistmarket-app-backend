const router = require('express').Router();
const tpsAuth = require('../middlewares/tpsAuth');
const { billInquiry, billPayment } = require('../controllers/tpsController');

// 1LINK / TPS API Routes mapped to /api/1.0/Payments
router.post('/BillInquiry', tpsAuth, billInquiry);
router.post('/BillPayment', tpsAuth, billPayment);

module.exports = router;
