import express from 'express';
import {
  getManagedVehicles,
  getVehicleDetails,
  updateManagedVehicle,
  getDashboardStats,
} from '../controllers/vehicleAuthorityController.js';
import { verifyVehicleAuthority } from '../middleware/authMiddleware.js';

const router = express.Router();

// All routes protected by verifyVehicleAuthority middleware
router.get('/dashboard-stats', verifyVehicleAuthority, getDashboardStats);
router.get('/vehicles', verifyVehicleAuthority, getManagedVehicles);
router.get('/vehicles/:id', verifyVehicleAuthority, getVehicleDetails);
router.patch('/vehicles/:id', verifyVehicleAuthority, updateManagedVehicle);

export default router;
