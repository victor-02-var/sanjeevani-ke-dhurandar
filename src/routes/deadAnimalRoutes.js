import express from 'express';
import {
  uploadDeadAnimalMulter,
  uploadDeadAnimalImage,
  createDeadAnimalReport,
  getMyDeadAnimalReports,
  getAllDeadAnimalReports,
  updateDeadAnimalReportStatus,
} from '../controllers/deadAnimalController.js';
import { optionalAuth, verifyAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

// POST /api/dead-animal-reports/upload-image - Upload photo & extract EXIF GPS location
router.post('/upload-image', uploadDeadAnimalMulter.single('file'), uploadDeadAnimalImage);

// POST /api/dead-animal-reports - Register dead animal complaint
router.post('/', optionalAuth, createDeadAnimalReport);

// GET /api/dead-animal-reports/me - Citizen fetches their own dead animal reports
router.get('/me', optionalAuth, getMyDeadAnimalReports);

// GET /api/dead-animal-reports/all - Admin fetches all complaints
router.get('/all', getAllDeadAnimalReports);

// PATCH /api/dead-animal-reports/:id/status - Admin updates report status & assigns driver
router.patch('/:id/status', updateDeadAnimalReportStatus);

export default router;
