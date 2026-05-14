const express = require('express');
const router = express.Router();
const { 
    getInventory, 
    addInventory, 
    initiateStockTransfer, 
    verifyStockTransfer, 
    getTransferHistory, 
    cancelStockTransfer,
    resendStockTransferOTP,
    requestStockTransfer,
    bulkDeleteInventory, 
    bulkUpdateInventory, 
    updateInventoryItem, 
    deleteInventoryItem 
} = require('../controllers/inventoryController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/inventory', authenticateJWT, getInventory);
router.post('/outlet/inventory', authenticateJWT, addInventory);

// Stock Transfers
router.post('/outlet/inventory/transfer/initiate', authenticateJWT, initiateStockTransfer);
router.post('/outlet/inventory/transfer/verify', authenticateJWT, verifyStockTransfer);
router.post('/outlet/inventory/transfer/cancel', authenticateJWT, cancelStockTransfer);
router.post('/outlet/inventory/transfer/resend-otp', authenticateJWT, resendStockTransferOTP);
router.post('/outlet/inventory/transfer/request', authenticateJWT, requestStockTransfer);
router.get('/outlet/inventory/transfers/history', authenticateJWT, getTransferHistory);

router.post('/outlet/inventory/bulk-delete', authenticateJWT, bulkDeleteInventory);
router.patch('/outlet/inventory/bulk-edit', authenticateJWT, bulkUpdateInventory);
router.patch('/outlet/inventory/:id', authenticateJWT, updateInventoryItem);
router.delete('/outlet/inventory/:id', authenticateJWT, deleteInventoryItem);

module.exports = router;

