import express from 'express';
import { verifyAndLogCollection, getCollectionLogs } from '../controllers/collectionController.js';
import { verifyAdmin } from '../middleware/authMiddleware.js';
import { upload } from '../config/cloudinary.js';

const router = express.Router();

// Apply verifyAdmin middleware to protect all collection endpoints
router.post('/', verifyAdmin, upload.single('photo'), verifyAndLogCollection);
router.get('/', verifyAdmin, getCollectionLogs);

export default router;