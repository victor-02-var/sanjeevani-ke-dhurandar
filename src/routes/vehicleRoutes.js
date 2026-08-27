import express from 'express';
import { getAllVehicles, getVehicleById, createVehicle, deleteVehicle, updateVehicle } from '../controllers/vehicleController.js';
import { verifyAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', getAllVehicles);
router.get('/:id', getVehicleById);
router.post('/', verifyAdmin, createVehicle);
router.patch('/:id', verifyAdmin, updateVehicle);
router.delete('/:id', verifyAdmin, deleteVehicle);

export default router;