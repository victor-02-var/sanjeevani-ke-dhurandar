import express from 'express';
import { adminLogin, adminSignup } from '../controllers/authAdminController.js';
// Optional: import { verifyAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

// Public Admin Signup (or add verifyAdmin middleware if only existing admins can register new admins)
router.post('/signup', adminSignup);

// Admin Login
router.post('/login', adminLogin);

export default router;