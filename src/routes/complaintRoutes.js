import express from 'express';
import { 
  verifyImageOnly,
  createComplaint, 
  getCitizenComplaints, 
  getAllComplaintsForAdmin,
  assignDriverToComplaint,
  updateComplaintStatus
} from '../controllers/complaintController.js';
import { getComplaintTimeline, toggleTimelineVisibility } from '../controllers/timelineController.js';
import { verifyCitizen, verifyAdmin, optionalAuth } from '../middleware/authMiddleware.js';
import { upload } from '../config/cloudinary.js';

const router = express.Router();

// Citizen Routes
router.post('/verify-image', optionalAuth, upload.single('image'), verifyImageOnly);
router.post('/', verifyCitizen, upload.single('image'), createComplaint);
router.get('/my-complaints', verifyCitizen, getCitizenComplaints);

// Timeline — citizen can view if visible, admin can always view
router.get('/:id/timeline', verifyCitizen, getComplaintTimeline);

// Admin Routes
router.get('/admin/all', verifyAdmin, getAllComplaintsForAdmin);
router.patch('/:id/assign', verifyAdmin, assignDriverToComplaint);
router.patch('/:id/status', verifyAdmin, upload.single('image'), updateComplaintStatus);
router.patch('/:id/timeline/toggle', verifyAdmin, toggleTimelineVisibility);

export default router;