const express = require('express');
const router = express.Router();
const { globalSearch, checkCNICOrders, checkPhoneOrders, getCNICOrderHistory, getPersonOrderHistory } = require('../controllers/searchController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/search', authenticateJWT, globalSearch);
router.post('/check-cnic', authenticateJWT, checkCNICOrders);
router.post('/check-phone', authenticateJWT, checkPhoneOrders);
router.get('/cnic-history', authenticateJWT, getCNICOrderHistory);
router.get('/person-history', authenticateJWT, getPersonOrderHistory);

module.exports = router;
