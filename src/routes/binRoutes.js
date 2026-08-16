import express from 'express';
import {
  getAllBins,
  getBinById,
  createBin,
  updateBin,
  deleteBin,
  simulateIoTTelemetry,
  resetBinData,
} from '../controllers/binController.js';
import { verifyAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

// Public / Map Routes
router.get('/', getAllBins);
router.get('/:id', getBinById);

// Admin / IoT Management Routes
router.post('/', verifyAdmin, createBin);
router.put('/:id', verifyAdmin, updateBin);
router.delete('/:id', verifyAdmin, deleteBin);

// IoT Simulation Routes
router.post('/simulate-telemetry', simulateIoTTelemetry);
router.post('/reset-simulation', verifyAdmin, resetBinData);

export default router;