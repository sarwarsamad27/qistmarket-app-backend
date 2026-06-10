const express = require('express');
const { authenticateEmployeeJWT } = require('../middlewares/employeeAuthMiddleware');
const { employeeLogin, getEmployeeMe } = require('../controllers/employeeAuthController');
const {
  getDashboard,
  getProfile,
  getTimeline,
  getAttendance,
  getPayroll,
  getLoans,
  getLeaves,
  applyLeave,
  getNotifications,
  markNotificationsRead,
  getDocuments,
  getPerformance,
} = require('../controllers/employeePortalController');

const router = express.Router();

router.post('/employee/login', employeeLogin);
router.get('/employee/me', authenticateEmployeeJWT, getEmployeeMe);
router.get('/employee/dashboard', authenticateEmployeeJWT, getDashboard);
router.get('/employee/profile', authenticateEmployeeJWT, getProfile);
router.get('/employee/timeline', authenticateEmployeeJWT, getTimeline);
router.get('/employee/attendance', authenticateEmployeeJWT, getAttendance);
router.get('/employee/payroll', authenticateEmployeeJWT, getPayroll);
router.get('/employee/loans', authenticateEmployeeJWT, getLoans);
router.get('/employee/leaves', authenticateEmployeeJWT, getLeaves);
router.post('/employee/leaves', authenticateEmployeeJWT, applyLeave);
router.get('/employee/notifications', authenticateEmployeeJWT, getNotifications);
router.patch('/employee/notifications/read', authenticateEmployeeJWT, markNotificationsRead);
router.get('/employee/documents', authenticateEmployeeJWT, getDocuments);
router.get('/employee/performance', authenticateEmployeeJWT, getPerformance);

module.exports = router;
