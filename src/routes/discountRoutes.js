const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionMiddleware');
const { createDiscountRequest, getDiscountRequests, decideDiscountRequest } = require('../controllers/discountController');

router.post('/', authenticateJWT, createDiscountRequest);
router.get('/', authenticateJWT, getDiscountRequests);
router.patch('/:id/decide', authenticateJWT, requirePermission('approve_discounts'), decideDiscountRequest);

module.exports = router;
