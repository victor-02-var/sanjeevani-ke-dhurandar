import express from 'express';
import { citizenSignup, citizenLogin, citizenGoogleAuth } from '../controllers/authCitizenController.js';

const router = express.Router();

router.post('/signup', citizenSignup);
router.post('/login', citizenLogin);
router.post('/google', citizenGoogleAuth);

export default router;