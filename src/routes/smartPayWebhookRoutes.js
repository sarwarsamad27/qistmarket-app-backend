const express = require('express');
const router = express.Router();
const { generateToken, notifyPayment } = require('../controllers/smartPayController');

router.post('/token', generateToken);
router.post('/notify', notifyPayment);

module.exports = router;
