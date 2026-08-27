import express from 'express';
import {
	citizenSendOtp,
	citizenSignup,
	citizenLogin,
	citizenGoogleAuth,
	citizenRefreshToken,
} from '../controllers/authCitizenController.js';

const router = express.Router();

router.post('/send-otp', citizenSendOtp);
router.post('/signup', citizenSignup);
router.post('/login', citizenLogin);
router.post('/google', citizenGoogleAuth);
router.post('/refresh', citizenRefreshToken);

export default router;