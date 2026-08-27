import express from 'express';
import { getCitizenProfile, updateCitizenProfile } from '../controllers/citizenController.js';
import { verifyCitizen } from '../middleware/authMiddleware.js';

const router = express.Router();

// Protected citizen routes
router.get('/profile', verifyCitizen, getCitizenProfile);
router.patch('/profile', verifyCitizen, updateCitizenProfile);

export default router;
