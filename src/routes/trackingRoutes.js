import express from 'express';
import { getAssignedDriversTracking } from '../controllers/driverTrackingController.js';
// import { verifyAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/assigned-drivers', getAssignedDriversTracking);

export default router;