import express from 'express';
import { optimizeFleetRoutes, getDriverRoute, getDriverLeaderboard } from '../controllers/routeController.js';
import { verifyAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

// Admin: triggers full multi-vehicle fleet route optimization
router.post('/optimize-fleet', verifyAdmin, optimizeFleetRoutes);

// Admin / Driver: get last computed optimized route for a specific vehicle
// Public — no admin auth so the vehicle/driver dashboard can call it directly
router.get('/driver-route/:vehicleId', getDriverRoute);

// Admin: driver leaderboard
router.get('/leaderboard', verifyAdmin, getDriverLeaderboard);

export default router;