import express from 'express';
import {
  logVehicleScan,
  getVehicleByQR,
  getMyVehicleScans,
  getAllScans,
  verifyScan,
  uploadScanImage,
  upload
} from '../controllers/qrScanController.js';
import { authenticateToken, verifyAdmin, optionalAuth, authenticateVehicleOrUser } from '../middleware/authMiddleware.js';

const router = express.Router();

// Public - Get vehicle info from QR code
router.get('/vehicle/:qr_code', getVehicleByQR);

// Citizen - Upload scan image (optional auth - works logged in or anonymous)
router.post('/upload-image', optionalAuth, upload.single('file'), uploadScanImage);

// Citizen - Log a scan (optional auth - works logged in or anonymous)
router.post('/scan', optionalAuth, logVehicleScan);

// Vehicle Authority / Driver - Get scans of their vehicle (accepts both Supabase tokens and vehicle JWTs)
router.get('/scans/my-vehicle', authenticateVehicleOrUser, getMyVehicleScans);

// Admin - Get all scans
router.get('/scans/all', authenticateToken, verifyAdmin, getAllScans);

// Admin - Verify a scan
router.patch('/scans/:id/verify', authenticateToken, verifyAdmin, verifyScan);

export default router;
