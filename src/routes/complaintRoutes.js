import express from 'express';
import { 
  createComplaint, 
  getCitizenComplaints, 
  getAllComplaintsForAdmin,
  assignDriverToComplaint,
  updateComplaintStatus
} from '../controllers/complaintController.js';
import { verifyCitizen, verifyAdmin } from '../middleware/authMiddleware.js';
import { upload } from '../config/cloudinary.js';

const router = express.Router();

// Citizen Routes
router.post('/', verifyCitizen, upload.single('image'), createComplaint);
router.get('/my-complaints', verifyCitizen, getCitizenComplaints);

// Admin Routes
router.get('/admin/all', verifyAdmin, getAllComplaintsForAdmin);
router.patch('/:id/assign', verifyAdmin, assignDriverToComplaint);

router.patch('/:id/status', verifyAdmin, upload.single('image'), updateComplaintStatus);
export default router;