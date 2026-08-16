import express from 'express';
import { optimizeFleetRoutes } from '../controllers/routeController.js';
import { verifyAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

// Admin Route: Triggers full multi-vehicle fleet route optimization
router.post('/optimize-fleet', verifyAdmin, optimizeFleetRoutes);



export default router;