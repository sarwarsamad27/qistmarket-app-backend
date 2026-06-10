const express = require('express');
const { authenticateJWT } = require('../middlewares/authMiddleware');
const { requireHRAdmin } = require('../middlewares/employeeAuthMiddleware');
const upload = require('../middlewares/uploadMiddleware');
const {
  createEmployee,
  getEmployees,
  getEmployeeById,
  updateEmployee,
  togglePortalAccess,
  resetEmployeePassword,
  sendEmployeeCredentials,
  sendAnnouncement,
  addEmploymentEvent,
  addPayrollSlip,
  recordAttendance,
  hrLogin,
  getHrDashboardStats,
  // biometric
  recordBiometricAttendance,
  getBiometricDeviceStatus,
  syncBiometricAttendance,
  // loans
  createEmployeeLoan,
  getEmployeeLoans,
  closeEmployeeLoan,
  // documents
  uploadEmployeeDocument,
  deleteEmployeeDocument,
  // performance
  getEmployeePerformance,
  updateEmployeePerformance,
  // attendance
  getEmployeeAttendance,
  bulkRecordAttendance,
  // payroll
  getEmployeePayroll,
  updatePayrollSlip,
} = require('../controllers/hrEmployeeController');
const { approveLeave, getPendingLeaves } = require('../controllers/employeePortalController');
const {
  getDocumentTemplates,
  getDocumentTemplatePreview,
  issueDocument,
  bulkIssueDocument,
  editDocument,
  getDocumentHistory,
} = require('../controllers/hrDocumentController');

const router = express.Router();

// Public route: HR login
router.post('/login', hrLogin);

// Protected HR routes
router.use(authenticateJWT, requireHRAdmin);

router.get('/dashboard-stats', getHrDashboardStats);

// Employees CRUD
router.get('/employees', getEmployees);
router.post('/employees', createEmployee);
router.get('/employees/:id', getEmployeeById);
router.patch('/employees/:id', updateEmployee);
router.patch('/employees/:id/portal', togglePortalAccess);
router.post('/employees/:id/reset-password', resetEmployeePassword);
router.post('/employees/:id/send-credentials', sendEmployeeCredentials);

// Employee timeline
router.post('/employees/:id/events', addEmploymentEvent);

// Employee loans
router.get('/employees/:id/loans', getEmployeeLoans);
router.post('/employees/:id/loans', createEmployeeLoan);
router.patch('/loans/:loanId/close', closeEmployeeLoan);

// Employee documents
router.post('/employees/:id/documents', upload.single('file'), uploadEmployeeDocument);
router.delete('/documents/:docId', deleteEmployeeDocument);

// Document templates & issuing
router.get('/document-templates', getDocumentTemplates);
router.get('/document-templates/:doc_type/preview/:employee_id', getDocumentTemplatePreview);
router.post('/documents/issue', issueDocument);
router.post('/documents/bulk-issue', bulkIssueDocument);
router.patch('/documents/:docId/edit', editDocument);
router.get('/documents/:docId/history', getDocumentHistory);

// Employee performance
router.get('/employees/:id/performance', getEmployeePerformance);
router.post('/employees/:id/performance', updateEmployeePerformance);

// Employee attendance
router.get('/employees/:id/attendance', getEmployeeAttendance);
router.post('/employees/:id/attendance', recordAttendance);
router.post('/attendance/bulk', bulkRecordAttendance);

// Employee payroll
router.get('/employees/:id/payroll', getEmployeePayroll);
router.post('/employees/:id/payroll', addPayrollSlip);
router.patch('/payroll/:slipId', updatePayrollSlip);

// Biometric
router.post('/biometric/punch', recordBiometricAttendance);
router.get('/biometric/device-status', getBiometricDeviceStatus);
router.post('/biometric/sync', syncBiometricAttendance);

// Announcements & Leaves
router.post('/announcements', sendAnnouncement);
router.get('/leaves/pending', getPendingLeaves);
router.patch('/leaves/:requestId', approveLeave);

module.exports = router;
