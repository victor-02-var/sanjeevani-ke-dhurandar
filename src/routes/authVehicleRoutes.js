import express from 'express';
import {
  vehicleLogin,
  getVehicleDashboard,
  getVehicleProfile,
  getVehicleScanLogs,
  getVehicleQRCode,
  authenticateVehicle
} from '../controllers/authVehicleController.js';

const router = express.Router();

// Public routes
router.post('/login', vehicleLogin);

// Protected routes (require vehicle authentication)
router.get('/dashboard', authenticateVehicle, getVehicleDashboard);
router.get('/profile', authenticateVehicle, getVehicleProfile);
router.get('/scan-logs', authenticateVehicle, getVehicleScanLogs);
router.get('/qr-code', authenticateVehicle, getVehicleQRCode);

export default router;
