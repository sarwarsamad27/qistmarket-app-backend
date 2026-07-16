const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionMiddleware');
const { rescheduleInstallment } = require('../controllers/installmentController');

router.patch('/:orderId/reschedule', authenticateJWT, requirePermission('reschedule_installments'), rescheduleInstallment);

module.exports = router;
