import express from 'express';
import { 
  vehicleAuthorityLogin, 
  getVehicleAuthorityProfile, 
  updateVehicleAuthorityProfile 
} from '../controllers/authVehicleAuthorityController.js';
import { authenticateToken } from '../middleware/authMiddleware.js';

const router = express.Router();

// Public routes
router.post('/login', vehicleAuthorityLogin);

// Protected routes (require authentication)
router.get('/profile', authenticateToken, getVehicleAuthorityProfile);
router.patch('/profile', authenticateToken, updateVehicleAuthorityProfile);

export default router;
