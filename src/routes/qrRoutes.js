import express from 'express';
import multer from 'multer';
import {
  // Driver endpoints
  generateQRCode,
  getMyQRCodes,
  toggleQRCodeStatus,
  
  // Citizen endpoints
  validateQRCode,
  submitQRScan,
  getMyScanHistory,
  
  // Admin endpoints
  getAllScanLogs,
  getAllQRCodes,
  verifyScan,
  getQRStats,
} from '../controllers/qrCodeController.js';
import { verifyDriver, verifyCitizen, verifyAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

// Configure multer for memory storage (photo uploads)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// ==========================================
// DRIVER ROUTES
// ==========================================

router.post('/generate', verifyDriver, generateQRCode);
router.get('/my-codes', verifyDriver, getMyQRCodes);
router.patch('/:id/toggle', verifyDriver, toggleQRCodeStatus);

// ==========================================
// CITIZEN ROUTES
// ==========================================

router.get('/validate/:qr_code', validateQRCode); // Public validation
router.post('/scan', verifyCitizen, upload.single('photo'), submitQRScan);
router.get('/my-scans', verifyCitizen, getMyScanHistory);

// ==========================================
// ADMIN ROUTES
// ==========================================

router.get('/admin/all-scans', verifyAdmin, getAllScanLogs);
router.get('/admin/all-qr-codes', verifyAdmin, getAllQRCodes);
router.patch('/admin/verify/:id', verifyAdmin, verifyScan);
router.get('/admin/stats', verifyAdmin, getQRStats);

export default router;
