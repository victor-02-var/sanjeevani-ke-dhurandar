import express from 'express';
import { 
  driverSendOtp, 
  driverSignup, 
  driverLogin, 
  getDriverProfile, 
  updateDriverProfile,
  getDriverVehicleQR
} from '../controllers/authDriverController.js';
import { authenticateToken } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/send-otp', driverSendOtp);
router.post('/signup', driverSignup);
router.post('/login', driverLogin);

// Protected profile endpoints
router.get('/profile', authenticateToken, getDriverProfile);
router.patch('/profile', authenticateToken, updateDriverProfile);

// Vehicle QR code endpoint
router.get('/qr-code', authenticateToken, getDriverVehicleQR);

export default router;