import express from 'express';
import { createDriverProfile, getDriverProfile } from '../controllers/driverProfileController.js';
import { getDriverMap } from '../controllers/driverMapController.js';
import { verifyDriver } from '../middleware/authMiddleware.js';
import { upload } from '../config/cloudinary.js';

const router = express.Router();

router.post('/profile', verifyDriver, upload.single('driving_license_photo'), createDriverProfile);
router.get('/profile', verifyDriver, getDriverProfile);
router.get('/map', verifyDriver, getDriverMap);

export default router;
