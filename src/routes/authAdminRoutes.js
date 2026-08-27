import express from 'express';
import { 
  adminLogin, 
  adminSignup,
  createVehicleAuthority,
  getAllVehicleAuthorities,
  toggleVehicleAuthorityStatus,
  deleteVehicleAuthority,
  confirmVehicleAuthorityEmail
} from '../controllers/authAdminController.js';
import { authenticateToken, verifyAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

// Public Admin Signup (or add verifyAdmin middleware if only existing admins can register new admins)
router.post('/signup', adminSignup);

// Admin Login
router.post('/login', adminLogin);

// Vehicle Authority Management (Protected - Admin only)
router.post('/create-vehicle-authority', authenticateToken, verifyAdmin, createVehicleAuthority);
router.get('/vehicle-authorities', authenticateToken, verifyAdmin, getAllVehicleAuthorities);
router.patch('/vehicle-authority/:id/toggle-status', authenticateToken, verifyAdmin, toggleVehicleAuthorityStatus);
router.patch('/vehicle-authority/:id/confirm-email', authenticateToken, verifyAdmin, confirmVehicleAuthorityEmail);
router.delete('/vehicle-authority/:id', authenticateToken, verifyAdmin, deleteVehicleAuthority);

export default router;