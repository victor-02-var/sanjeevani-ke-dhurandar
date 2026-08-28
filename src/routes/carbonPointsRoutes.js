import express from 'express';
import {
  calculateCarbonPoints,
  getAllCarbonPoints,
  getMyCarbonPoints,
  getCarbonCardPDF,
  externalVerifyPoints,
  claimCarbonPointsBenefit,
  lockTaxWalletPoints,
  releaseTaxWalletPoints,
} from '../controllers/carbonPointsController.js';
import { verifyAdmin, verifyCitizen, optionalAuth } from '../middleware/authMiddleware.js';
import { externalApiRateLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// Citizen private endpoints
router.get('/me', verifyCitizen, getMyCarbonPoints);
router.post('/wallet/lock', verifyCitizen, lockTaxWalletPoints);
router.post('/wallet/release', verifyCitizen, releaseTaxWalletPoints);

// Public PDF Download
router.get('/card-pdf/:citizenId', getCarbonCardPDF);

// Admin endpoint
router.get('/admin/all', verifyAdmin, getAllCarbonPoints);
router.post('/calculate', verifyAdmin, calculateCarbonPoints);

// External Bill Payment Integration APIs (Rate Limited)
router.post('/external-verify', externalApiRateLimiter(60, 60 * 1000), externalVerifyPoints);
router.post('/claim-benefit', externalApiRateLimiter(60, 60 * 1000), optionalAuth, claimCarbonPointsBenefit);

export default router;
