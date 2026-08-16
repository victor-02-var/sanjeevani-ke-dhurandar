import express from 'express';
import { getAllVehicles, getVehicleById } from '../controllers/vehicleController.js';

const router = express.Router();

// Public / React Leaflet Map Routes
router.get('/', getAllVehicles);
router.get('/:id', getVehicleById);

export default router;