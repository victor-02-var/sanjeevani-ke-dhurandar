import express from 'express';
import { 
  getAllCitizens, 
  getCitizenById, 
  toggleCitizenStatus,
  getAdminStats 
} from '../controllers/adminController.js';
import { verifyAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

// All routes require admin authentication
router.use(verifyAdmin);

// Citizen management
router.get('/citizens', getAllCitizens);
router.get('/citizens/:id', getCitizenById);
router.patch('/citizens/:id/toggle-status', toggleCitizenStatus);

// Dashboard stats
router.get('/stats', getAdminStats);

export default router;
