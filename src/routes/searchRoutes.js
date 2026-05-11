const express = require('express');
const router = express.Router();
const { globalSearch, checkCNICOrders, checkPhoneOrders } = require('../controllers/searchController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/search', authenticateJWT, globalSearch);
router.post('/check-cnic', authenticateJWT, checkCNICOrders);
router.post('/check-phone', authenticateJWT, checkPhoneOrders);

module.exports = router;
