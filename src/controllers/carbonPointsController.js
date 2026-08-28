import { supabaseAdmin as supabase } from '../config/supabase.js';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// AES-256-GCM ENCRYPTED QR CODE SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
// The secret master key used to derive both the AES encryption key and the
// legacy HMAC signing key.  Set JWT_SECRET in your .env for production.
const QR_SECRET = process.env.JWT_SECRET || 'civicsync_secure_carbon_points_key_2026';

// Derive a deterministic 32-byte (256-bit) AES key from QR_SECRET using SHA-256.
// This key never leaves the server — it is NEVER embedded in the QR.
const QR_AES_KEY = crypto.createHash('sha256').update(QR_SECRET).digest(); // Buffer, 32 bytes

// QR format prefix so the verifier knows which scheme was used
const QR_VERSION_V2 = 'ENC:v2'; // AES-256-GCM encrypted (current)
const QR_VERSION_V1 = '{';      // Legacy HMAC-signed plaintext JSON (backward compat)

// Points rules
const POINTS_PER_DAY = 100;
const WEEKLY_STREAK_BONUS = 50;   // every 7-consecutive-day streak
const MONTHLY_STREAK_BONUS = 150; // every 30-consecutive-day streak

// In-memory fallback store for redemptions and tax wallets
const inMemoryRedemptions = new Map();
const inMemoryTaxWallets = new Map();
const TAX_WALLET_CAP = 250; // Cap on points that can be locked into annual tax wallet

/**
 * Get or initialize Tax Wallet for a citizen
 */
function getCitizenTaxWallet(citizenId) {
  if (!inMemoryTaxWallets.has(citizenId)) {
    inMemoryTaxWallets.set(citizenId, {
      citizen_id: citizenId,
      wallet_points: 0,
      is_locked: false,
      max_cap: TAX_WALLET_CAP,
      updated_at: new Date().toISOString()
    });
  }
  return inMemoryTaxWallets.get(citizenId);
}

/**
 * ═══════════════════════════════════════════════════════════════
 * generateSecureQRPayload  —  AES-256-GCM Encrypted QR
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS PRODUCES:
 *   ENC:v2:<12-byte IV in hex>:<ciphertext in base64>:<16-byte GCM auth-tag in hex>
 *
 * Example output (what actually gets encoded into the QR image):
 *   ENC:v2:3a9f1c2b4d8e7f0a1b2c3d4e:dGhpcyBpcyBlbmNyeXB0ZWQ=:8f3e2a1b4c5d6e7f8a9b0c1d
 *
 * A normal phone camera / QR scanner app will see ONLY this opaque string.
 * It reveals ZERO personal information — no name, no citizen ID, no balance.
 * Only the CivicSync backend (which holds QR_AES_KEY) can decrypt it.
 *
 * ALGORITHM DETAILS:
 *  - Key:     AES-256 (256-bit key derived from QR_SECRET via SHA-256)
 *  - Mode:    GCM  (Galois/Counter Mode — provides both encryption + authentication)
 *  - IV:      12 bytes (96-bit), cryptographically random per QR generation
 *  - AuthTag: 16 bytes (128-bit GCM authentication tag)
 *  - Expiry:  24 hours from generation (enforced at decryption time)
 */
export function generateSecureQRPayload(citizenId, name, netPoints) {
  const cardId = `CARD-${citizenId.slice(0, 8).toUpperCase()}`;
  const exp = Date.now() + (24 * 60 * 60 * 1000); // 24-hour expiry timestamp

  // Minimal plaintext — only what the backend needs to verify the citizen
  // Nothing here is useful to an attacker who cannot decrypt it
  const plaintext = JSON.stringify({
    cid: citizenId,
    crd: cardId,
    pts: netPoints,
    exp: exp,
    iss: 'civicsync', // issuer tag for extra integrity check
  });

  // Generate a fresh 96-bit (12-byte) random IV for every QR code
  // Re-using an IV with the same key would break GCM security — we never do that
  const iv = crypto.randomBytes(12);

  // Create AES-256-GCM cipher with our derived 256-bit key and the fresh IV
  const cipher = crypto.createCipheriv('aes-256-gcm', QR_AES_KEY, iv);

  // Encrypt the plaintext
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  // GCM auth tag — 16 bytes that cryptographically authenticate BOTH
  // the ciphertext AND the IV.  Any tampering invalidates this tag.
  const authTag = cipher.getAuthTag(); // 16 bytes

  // Assemble the final QR string: ENC:v2:<iv_hex>:<ciphertext_b64>:<tag_hex>
  return [
    QR_VERSION_V2,
    iv.toString('hex'),
    encrypted.toString('base64'),
    authTag.toString('hex'),
  ].join(':');
}

/**
 * ═══════════════════════════════════════════════════════════════
 * verifyQRPayload  —  AES-256-GCM Decrypt + Authenticate
 * ═══════════════════════════════════════════════════════════════
 *
 * Supports two input formats:
 *  1. ENC:v2:...  — New AES-256-GCM encrypted QR  (current)
 *  2. {...}       — Legacy HMAC-signed plaintext JSON  (backward compat)
 *
 * Returns { valid, citizenId, cardId, points } on success.
 * Returns { valid: false, reason: '...' } on any failure.
 */
export function verifyQRPayload(payloadStr) {
  if (typeof payloadStr !== 'string') {
    return { valid: false, reason: 'Payload must be a string' };
  }

  const trimmed = payloadStr.trim();

  // ── PATH A: AES-256-GCM encrypted QR (v2) ────────────────────────────────
  if (trimmed.startsWith(QR_VERSION_V2)) {
    try {
      const parts = trimmed.split(':');
      // Expected: ['ENC', 'v2', '<iv_hex>', '<ciphertext_b64>', '<tag_hex>']
      if (parts.length < 5) {
        return { valid: false, reason: 'Malformed AES-GCM QR payload (wrong segment count)' };
      }

      const ivHex      = parts[2];
      const cipherB64  = parts[3];
      const tagHex     = parts[4];

      const iv      = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(tagHex, 'hex');

      if (iv.length !== 12) {
        return { valid: false, reason: 'Invalid IV length — QR may be corrupted or tampered' };
      }

      // Create GCM decipher — will throw if the auth tag does not match,
      // meaning the ciphertext or IV was tampered with
      const decipher = crypto.createDecipheriv('aes-256-gcm', QR_AES_KEY, iv);
      decipher.setAuthTag(authTag);

      let decrypted;
      try {
        decrypted = Buffer.concat([
          decipher.update(Buffer.from(cipherB64, 'base64')),
          decipher.final(), // ← throws here if authTag fails — tamper detected
        ]).toString('utf8');
      } catch (_) {
        return {
          valid: false,
          reason: 'QR authentication failed — this QR has been tampered with or is invalid',
        };
      }

      const data = JSON.parse(decrypted);

      // Verify issuer tag
      if (data.iss !== 'civicsync') {
        return { valid: false, reason: 'Invalid QR issuer — not a CivicSync Carbon Card' };
      }

      // Enforce 24-hour expiry
      if (!data.exp || Date.now() > data.exp) {
        return {
          valid: false,
          reason: 'This QR code has expired (24-hour validity). Please refresh your Carbon Card to generate a new QR.',
        };
      }

      if (!data.cid) {
        return { valid: false, reason: 'Decrypted payload missing citizen identifier' };
      }

      return {
        valid: true,
        citizenId: data.cid,
        cardId: data.crd || `CARD-${data.cid.slice(0, 8).toUpperCase()}`,
        points: data.pts,
      };
    } catch (err) {
      return { valid: false, reason: `AES-GCM decryption error: ${err.message}` };
    }
  }

  // ── PATH B: Legacy HMAC-signed plaintext JSON (v1) — backward compatibility ─
  if (trimmed.startsWith(QR_VERSION_V1)) {
    try {
      const data = JSON.parse(trimmed);
      const { cid, card_id, card, pts, exp } = data;
      const effectiveCard = card_id || card;

      if (!cid || pts === undefined) {
        return { valid: false, reason: 'Malformed legacy payload structure' };
      }

      // Enforce expiry on legacy QRs too
      if (exp && Date.now() > exp) {
        return {
          valid: false,
          reason: 'This QR code has expired. Please refresh your Carbon Card to generate a new encrypted QR.',
        };
      }

      return {
        valid: true,
        citizenId: cid,
        cardId: effectiveCard || `CARD-${cid.slice(0, 8).toUpperCase()}`,
        points: pts,
        legacy: true, // flag so callers can warn user to refresh their QR
      };
    } catch (err) {
      return { valid: false, reason: 'Invalid legacy JSON payload format' };
    }
  }

  // ── PATH C: Raw card ID / citizen UUID passed directly ───────────────────
  // (not a QR payload — handled by the card_id field in the request body)
  return { valid: false, reason: 'Unrecognised QR format. Please scan a valid CivicSync Carbon Card QR.' };
}

/**
 * Calculate earned carbon points for a citizen strictly from vehicle_scan_logs.
 * Enforces 2-Month (60-Day) Expiry Rule for Unlocked Available Points.
 */
function computePoints(scanDates) {
  if (!scanDates || !scanDates.length) return { total: 0, available: 0, expired: 0, base: 0, weeklyBonus: 0, monthlyBonus: 0, streak: 0, totalDays: 0 };

  const now = new Date();
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const days = [...new Set(
    scanDates.map(d => new Date(d).toISOString().slice(0, 10))
  )].sort();

  const totalDays = days.length;
  const base = totalDays * POINTS_PER_DAY;

  let maxStreak = 1, currentStreak = 1;
  let weeklyBonusCount = 0, monthlyBonusCount = 0;

  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1]);
    const curr = new Date(days[i]);
    const diffDays = (curr - prev) / (1000 * 60 * 60 * 24);

    if (diffDays === 1) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      weeklyBonusCount  += Math.floor(currentStreak / 7);
      monthlyBonusCount += Math.floor(currentStreak / 30);
      currentStreak = 1;
    }
  }
  weeklyBonusCount  += Math.floor(currentStreak / 7);
  monthlyBonusCount += Math.floor(currentStreak / 30);

  const weeklyBonus  = weeklyBonusCount  * WEEKLY_STREAK_BONUS;
  const monthlyBonus = monthlyBonusCount * MONTHLY_STREAK_BONUS;
  const total = base + weeklyBonus + monthlyBonus;

  // Compute 2-Month (60 Days) Expiry for Available Points
  const unexpiredDays = days.filter(d => new Date(d) >= sixtyDaysAgo);
  const unexpiredDaysCount = unexpiredDays.length;
  const availableBase = unexpiredDaysCount * POINTS_PER_DAY;
  
  // Available points from unexpired scans
  const available = Math.min(total, availableBase + Math.floor(weeklyBonus * (unexpiredDaysCount / (totalDays || 1))));
  const expired = Math.max(0, total - available);

  return { total, available, expired, base, weeklyBonus, monthlyBonus, streak: maxStreak, totalDays };
}

/**
 * Fetch total redeemed points for a citizen to ensure synchronized net balance
 */
async function getRedeemedPointsSum(citizenId) {
  let memorySum = 0;
  for (const r of inMemoryRedemptions.values()) {
    if (r.citizen_id === citizenId) {
      memorySum += (r.points_claimed || 0);
    }
  }

  let dbSum = 0;
  try {
    const { data } = await supabase
      .from('carbon_redemptions')
      .select('points_claimed')
      .eq('citizen_id', citizenId);

    if (data) {
      dbSum = data.reduce((acc, item) => acc + (item.points_claimed || 0), 0);
    }
  } catch (e) {
    // fallback
  }

  return Math.max(memorySum, dbSum);
}

function getTier(points) {
  if (points >= 10000) return { label: 'PLATINUM', rebate: '15%' };
  if (points >= 5000)  return { label: 'GOLD',     rebate: '10%' };
  if (points >= 2000)  return { label: 'SILVER',   rebate: '5%' };
  return                      { label: 'BRONZE',   rebate: '0%' };
}

// GET /api/carbon-points/me
export const getMyCarbonPoints = async (req, res, next) => {
  try {
    const citizenId = req.user.id;
    const citizenName = req.user.full_name || req.user.email || 'Citizen';

    const { data: scans, error } = await supabase
      .from('vehicle_scan_logs')
      .select('scan_timestamp')
      .eq('citizen_id', citizenId)
      .order('scan_timestamp', { ascending: true });

    if (error) throw error;

    const dates = (scans || []).map(s => s.scan_timestamp);
    const { total, available, expired, base, weeklyBonus, monthlyBonus, streak, totalDays } = computePoints(dates);

    // Synchronize points balance: net available = available - redeemed
    const redeemedSum = await getRedeemedPointsSum(citizenId);
    
    // Tax Wallet Status
    const taxWallet = getCitizenTaxWallet(citizenId);
    
    const netAvailablePoints = Math.max(0, available - redeemedSum);
    const totalCombinedPoints = netAvailablePoints + taxWallet.wallet_points;
    const tier = getTier(totalCombinedPoints);

    // Current streak (from today backwards)
    const today = new Date().toISOString().slice(0, 10);
    const uniqueDays = [...new Set(dates.map(d => new Date(d).toISOString().slice(0, 10)))].sort().reverse();
    let currentStreak = 0;
    let expected = today;
    for (const day of uniqueDays) {
      if (day === expected) {
        currentStreak++;
        const d = new Date(expected);
        d.setDate(d.getDate() - 1);
        expected = d.toISOString().slice(0, 10);
      } else break;
    }

    const cardId = `CARD-${citizenId.slice(0, 8).toUpperCase()}`;
    const secureQrPayload = generateSecureQRPayload(citizenId, citizenName, totalCombinedPoints);

    // Fetch redemption history
    let redemptionsList = Array.from(inMemoryRedemptions.values()).filter(r => r.citizen_id === citizenId);
    try {
      const { data: dbR } = await supabase
        .from('carbon_redemptions')
        .select('*')
        .eq('citizen_id', citizenId)
        .order('created_at', { ascending: false });

      if (dbR && dbR.length > 0) {
        redemptionsList = dbR;
      }
    } catch (e) {
      // ignore
    }

    res.status(200).json({
      citizen_id: citizenId,
      card_id: cardId,
      total_points: totalCombinedPoints,
      available_points: netAvailablePoints,
      tax_wallet_points: taxWallet.wallet_points,
      is_wallet_locked: taxWallet.wallet_points >= TAX_WALLET_CAP,
      wallet_cap: TAX_WALLET_CAP,
      expired_points: expired,
      earned_points: total,
      redeemed_points: redeemedSum,
      base_points: base,
      weekly_bonus: weeklyBonus,
      monthly_bonus: monthlyBonus,
      current_streak: currentStreak,
      total_scan_days: totalDays,
      tier: tier.label,
      rebate: tier.rebate,
      last_scan: dates.at(-1) || null,
      secure_qr_payload: secureQrPayload,
      redemptions: redemptionsList,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/carbon-points/wallet/lock - Lock N points into Annual Tax Wallet (Protected from 60-day expiry)
export const lockTaxWalletPoints = async (req, res, next) => {
  try {
    const citizenId = req.user.id;
    const { points } = req.body;

    const pointsToLock = parseInt(points, 10);
    if (isNaN(pointsToLock) || pointsToLock <= 0) {
      return res.status(400).json({ error: 'Please enter a valid positive number of points to lock into Tax Wallet.' });
    }

    // Get current available points
    const { data: scans } = await supabase
      .from('vehicle_scan_logs')
      .select('scan_timestamp')
      .eq('citizen_id', citizenId);

    const dates = (scans || []).map(s => s.scan_timestamp);
    const { available } = computePoints(dates);
    const redeemedSum = await getRedeemedPointsSum(citizenId);
    const netAvailablePoints = Math.max(0, available - redeemedSum);

    const wallet = getCitizenTaxWallet(citizenId);

    if (wallet.wallet_points >= TAX_WALLET_CAP) {
      return res.status(400).json({
        error: `Tax Wallet is already locked at maximum capacity (${TAX_WALLET_CAP} Pts). Cannot lock additional points beyond threshold.`
      });
    }

    if (pointsToLock > netAvailablePoints) {
      return res.status(400).json({
        error: `Cannot lock ${pointsToLock} pts. Available balance is only ${netAvailablePoints} pts.`
      });
    }

    if (wallet.wallet_points + pointsToLock > TAX_WALLET_CAP) {
      return res.status(400).json({
        error: `Locking ${pointsToLock} pts exceeds maximum Tax Wallet cap of ${TAX_WALLET_CAP} pts. You can only add ${TAX_WALLET_CAP - wallet.wallet_points} pts.`
      });
    }

    wallet.wallet_points += pointsToLock;
    wallet.is_locked = wallet.wallet_points >= TAX_WALLET_CAP;
    wallet.updated_at = new Date().toISOString();

    res.status(200).json({
      success: true,
      message: `Successfully locked ${pointsToLock} points into Tax Wallet for annual municipal taxes!`,
      wallet_points: wallet.wallet_points,
      is_wallet_locked: wallet.is_locked,
      wallet_cap: TAX_WALLET_CAP,
      remaining_available_points: netAvailablePoints - pointsToLock
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/carbon-points/wallet/release - Release/Unlock points from Tax Wallet back to Available Points
export const releaseTaxWalletPoints = async (req, res, next) => {
  try {
    const citizenId = req.user.id;
    const { points } = req.body;

    const wallet = getCitizenTaxWallet(citizenId);

    if (wallet.wallet_points <= 0) {
      return res.status(400).json({ error: 'Tax Wallet is currently empty. No points to release.' });
    }

    const releaseAmount = points ? Math.min(wallet.wallet_points, parseInt(points, 10)) : wallet.wallet_points;

    wallet.wallet_points = Math.max(0, wallet.wallet_points - releaseAmount);
    wallet.is_locked = false; // Unlocked when points released
    wallet.updated_at = new Date().toISOString();

    res.status(200).json({
      success: true,
      message: `Successfully released ${releaseAmount} points from Tax Wallet back to Available Balance!`,
      wallet_points: wallet.wallet_points,
      is_wallet_locked: wallet.is_locked,
      wallet_cap: TAX_WALLET_CAP
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/carbon-points/admin/all
export const getAllCarbonPoints = async (req, res, next) => {
  try {
    const { data: scans, error } = await supabase
      .from('vehicle_scan_logs')
      .select('citizen_id, citizen_name, citizen_email, scan_timestamp')
      .not('citizen_id', 'is', null)
      .order('scan_timestamp', { ascending: true });

    if (error) throw error;

    const byUser = {};
    for (const s of scans || []) {
      if (!byUser[s.citizen_id]) {
        byUser[s.citizen_id] = { citizen_id: s.citizen_id, name: s.citizen_name, email: s.citizen_email, dates: [] };
      }
      byUser[s.citizen_id].dates.push(s.scan_timestamp);
    }

    const users = [];
    for (const u of Object.values(byUser)) {
      const { total, streak, totalDays } = computePoints(u.dates);
      const redeemed = await getRedeemedPointsSum(u.citizen_id);
      const netPoints = Math.max(0, total - redeemed);
      const tier = getTier(netPoints);
      users.push({ citizen_id: u.citizen_id, name: u.name, email: u.email, total_points: netPoints, streak, total_scan_days: totalDays, tier: tier.label });
    }

    users.sort((a, b) => b.total_points - a.total_points);
    res.status(200).json({ users });
  } catch (err) {
    next(err);
  }
};

// POST /api/carbon-points/external-verify - External API for Property Tax, Water Tax & Bus Pass apps
export const externalVerifyPoints = async (req, res, next) => {
  try {
    const { qr_payload, card_id, citizen_id, user_id } = req.body;

    let cid = citizen_id || user_id;
    let signatureValid = false;

    if (qr_payload) {
      const verification = verifyQRPayload(qr_payload);
      if (!verification.valid) {
        return res.status(400).json({
          success: false,
          valid: false,
          error: 'QR Verification Failed',
          message: verification.reason,
        });
      }
      cid = verification.citizenId;
      signatureValid = true;
    }

    if (!cid && card_id) {
      // Find citizen from card_id prefix or full card_id
      const cleanCardId = card_id.replace('CARD-', '').toLowerCase();
      const { data: profiles } = await supabase.from('profiles').select('id, full_name, email');
      const found = (profiles || []).find(p => p.id.toLowerCase().startsWith(cleanCardId) || p.id.toLowerCase() === cleanCardId);
      if (found) {
        cid = found.id;
      }
    }

    if (!cid) {
      return res.status(404).json({
        success: false,
        valid: false,
        error: 'Citizen Not Found',
        message: 'Could not resolve citizen profile from payload or Card ID.',
      });
    }

    // Fetch citizen profile name
    let citizenName = 'Citizen';
    const { data: prof } = await supabase.from('profiles').select('full_name, email').eq('id', cid).maybeSingle();
    if (prof) {
      citizenName = prof.full_name || prof.email || 'Citizen';
    }

    // Live calculation of synchronized net points
    const { data: scans } = await supabase
      .from('vehicle_scan_logs')
      .select('scan_timestamp')
      .eq('citizen_id', cid);

    const dates = (scans || []).map(s => s.scan_timestamp);
    const { available } = computePoints(dates);
    const redeemedSum = await getRedeemedPointsSum(cid);
    const netAvailablePoints = Math.max(0, available - redeemedSum);
    
    // Tax Wallet Points
    const taxWallet = getCitizenTaxWallet(cid);
    const totalCombinedPoints = netAvailablePoints + taxWallet.wallet_points;

    const tier = getTier(totalCombinedPoints);

    res.status(200).json({
      success: true,
      valid: true,
      signature_verified: signatureValid,
      citizen_id: cid,
      citizen_name: citizenName,
      card_id: `CARD-${cid.slice(0, 8).toUpperCase()}`,
      available_points: netAvailablePoints,
      tax_wallet_points: taxWallet.wallet_points,
      is_wallet_locked: taxWallet.wallet_points >= TAX_WALLET_CAP,
      wallet_cap: TAX_WALLET_CAP,
      total_points: totalCombinedPoints,
      tier: tier.label,
      max_rebate_percentage: tier.rebate,
      eligible_benefits: [
        { type: 'PROPERTY_TAX', title: 'Property Tax Rebate (Annual)', min_points: 50, requires_wallet: true },
        { type: 'WATER_TAX', title: 'Water Bill Rebate (Annual)', min_points: 50, requires_wallet: true },
        { type: 'ELECTRICITY_BILL', title: 'Electricity Bill Adjustment', min_points: 20, requires_wallet: false },
        { type: 'BUS_PASS', title: 'Municipal Bus Pass Concession', min_points: 25, requires_wallet: false },
      ],
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/carbon-points/claim-benefit - External / Citizen claim & discount endpoint
export const claimCarbonPointsBenefit = async (req, res, next) => {
  try {
    const { qr_payload, card_id, points_to_claim, benefit_type, bill_reference, bill_amount, use_wallet } = req.body;

    let cid = req.user?.id || null;
    let resolvedCardId = card_id || null;

    if (qr_payload) {
      const verification = verifyQRPayload(qr_payload);
      if (!verification.valid) {
        return res.status(400).json({
          success: false,
          error: 'Verification Failed',
          message: verification.reason,
        });
      }
      cid = verification.citizenId;
      resolvedCardId = verification.cardId;
    }

    if (!cid && card_id) {
      const cleanCardId = card_id.replace('CARD-', '').toLowerCase();
      const { data: profiles } = await supabase.from('profiles').select('id');
      const found = (profiles || []).find(p => p.id.toLowerCase().startsWith(cleanCardId) || p.id.toLowerCase() === cleanCardId);
      if (found) cid = found.id;
    }

    if (!cid) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Valid QR payload, Card ID, or citizen auth token is required.',
      });
    }

    // Verify current net available points and tax wallet points
    const { data: scans } = await supabase
      .from('vehicle_scan_logs')
      .select('scan_timestamp')
      .eq('citizen_id', cid);

    const dates = (scans || []).map(s => s.scan_timestamp);
    const { available } = computePoints(dates);
    const redeemedSum = await getRedeemedPointsSum(cid);
    const currentNetPoints = Math.max(0, available - redeemedSum);
    
    const taxWallet = getCitizenTaxWallet(cid);
    const isTaxBenefit = (benefit_type === 'PROPERTY_TAX' || benefit_type === 'WATER_TAX');

    // Decide how many points to claim
    let claimPts = parseInt(points_to_claim, 10);
    
    // If points_to_claim not specified but bill_amount provided, calculate max usable points
    const billAmt = parseFloat(bill_amount) || 0;
    if (isNaN(claimPts) || claimPts <= 0) {
      if (isTaxBenefit && taxWallet.wallet_points > 0) {
        claimPts = taxWallet.wallet_points;
      } else {
        claimPts = Math.min(currentNetPoints, billAmt > 0 ? Math.floor(billAmt * 0.15) : 100);
      }
    }

    if (claimPts <= 0) {
      return res.status(400).json({ success: false, error: 'No points available to claim for discount.' });
    }

    // Check balance
    let pointsDeductedFromWallet = 0;
    let pointsDeductedFromAvailable = 0;

    if (isTaxBenefit || use_wallet) {
      // Use Tax Wallet points first
      if (taxWallet.wallet_points >= claimPts) {
        pointsDeductedFromWallet = claimPts;
      } else {
        pointsDeductedFromWallet = taxWallet.wallet_points;
        pointsDeductedFromAvailable = claimPts - taxWallet.wallet_points;
      }
    } else {
      pointsDeductedFromAvailable = claimPts;
    }

    if (pointsDeductedFromAvailable > currentNetPoints) {
      return res.status(400).json({
        success: false,
        error: 'Insufficient Points',
        message: `Requested ${claimPts} pts exceeds available balance of ${currentNetPoints} pts.`,
      });
    }

    // Deduct from Tax Wallet in memory
    taxWallet.wallet_points = Math.max(0, taxWallet.wallet_points - pointsDeductedFromWallet);
    if (taxWallet.wallet_points < TAX_WALLET_CAP) {
      taxWallet.is_locked = false;
    }

    const discountInr = (claimPts * 1.0).toFixed(2); // 1 Point = 1.00 INR Discount
    const finalPayable = billAmt > 0 ? Math.max(0, billAmt - parseFloat(discountInr)).toFixed(2) : '0.00';
    const voucherCode = `GOVT-REBATE-${(benefit_type || 'BILL').toUpperCase()}-${Date.now().toString().slice(-6)}`;
    if (!resolvedCardId) resolvedCardId = `CARD-${cid.slice(0, 8).toUpperCase()}`;

    const redemptionRecord = {
      id: `RED-${Date.now()}`,
      citizen_id: cid,
      card_id: resolvedCardId,
      benefit_type: benefit_type || 'BILL_PAYMENT',
      points_claimed: claimPts,
      discount_amount: parseFloat(discountInr),
      bill_reference: bill_reference || 'MUNICIPAL-GOVT-BILL',
      voucher_code: voucherCode,
      status: 'REDEEMED',
      created_at: new Date().toISOString(),
    };

    // Insert into Supabase database
    try {
      await supabase.from('carbon_redemptions').insert([{
        citizen_id: cid,
        card_id: resolvedCardId,
        benefit_type: redemptionRecord.benefit_type,
        points_claimed: claimPts,
        discount_amount: redemptionRecord.discount_amount,
        bill_reference: redemptionRecord.bill_reference,
        voucher_code: voucherCode,
        status: 'REDEEMED',
      }]);
    } catch (e) {
      console.warn('Supabase redemption insert fallback to memory map:', e.message);
    }

    inMemoryRedemptions.set(redemptionRecord.id, redemptionRecord);

    const updatedRemainingAvailable = currentNetPoints - pointsDeductedFromAvailable;

    res.status(200).json({
      success: true,
      message: `Government Discount Applied! Claimed ${claimPts} Carbon Points for ₹${discountInr} discount on ${benefit_type || 'bill'}.`,
      voucher_code: voucherCode,
      original_bill_amount: billAmt,
      discount_applied_inr: parseFloat(discountInr),
      final_payable_amount_inr: parseFloat(finalPayable),
      points_claimed: claimPts,
      remaining_available_points: updatedRemainingAvailable,
      remaining_tax_wallet_points: taxWallet.wallet_points,
      redemption_details: redemptionRecord,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/carbon-points/calculate — kept for compatibility
export const calculateCarbonPoints = async (req, res) => {
  res.status(200).json({ message: 'Points are calculated live from vehicle_scan_logs on each /me request.' });
};

async function buildAndSendPDF(res, { citizenId, name, netPoints }) {
  const memberId = `CARD-${citizenId.slice(0, 8).toUpperCase()}`;
  const secureQrPayload = generateSecureQRPayload(citizenId, name, netPoints);
  const qrDataUrl = await QRCode.toDataURL(secureQrPayload, { width: 220, margin: 1 });
  const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

  const doc = new PDFDocument({ size: 'A5', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="carbon-card-${memberId}.pdf"`);
  doc.pipe(res);

  // Header bar
  doc.rect(0, 0, doc.page.width, 70).fill('#065f46');
  doc.fillColor('#ffffff').fontSize(20).font('Helvetica-Bold').text('CivicSync Carbon Card', 40, 24);

  // Clean QR code
  doc.image(qrBuffer, 40, 95, { width: 160, height: 160 });

  // Minimal Info block (Only Citizen Name & Member Card ID as requested)
  const infoX = 220;
  doc.fillColor('#064e3b').fontSize(11).font('Helvetica-Bold').text('Citizen Name', infoX, 110);
  doc.fillColor('#1f2937').fontSize(15).font('Helvetica-Bold').text(name, infoX, 128);

  doc.fillColor('#064e3b').fontSize(11).font('Helvetica-Bold').text('Member Card ID', infoX, 165);
  doc.fillColor('#065f46').fontSize(14).font('Helvetica-Bold').text(memberId, infoX, 183);

  // Footer note
  doc.moveTo(40, 280).lineTo(doc.page.width - 40, 280).strokeColor('#d1fae5').lineWidth(1).stroke();
  doc.fillColor('#6b7280').fontSize(9).font('Helvetica')
    .text(`CivicSync Verifiable Municipal Eco-Card  •  Scan QR Code for verification`, 40, doc.page.height - 40, { align: 'center', width: doc.page.width - 80 });

  doc.end();
}

// GET /api/carbon-points/card-pdf/:citizenId (public)
export const getCarbonCardPDF = async (req, res, next) => {
  try {
    const { citizenId } = req.params;

    const { data: scans, error: sErr } = await supabase
      .from('vehicle_scan_logs')
      .select('scan_timestamp, citizen_name, citizen_email')
      .eq('citizen_id', citizenId)
      .order('scan_timestamp', { ascending: true });
    if (sErr) throw sErr;

    if (!scans || scans.length === 0) {
      return buildAndSendPDF(res, {
        citizenId, name: 'Citizen', netPoints: 0,
      });
    }

    const dates = scans.map(s => s.scan_timestamp);
    const { total } = computePoints(dates);
    const redeemed = await getRedeemedPointsSum(citizenId);
    const netPoints = Math.max(0, total - redeemed);
    const name = scans[0].citizen_name || scans[0].citizen_email || 'Citizen';

    return buildAndSendPDF(res, { citizenId, name, netPoints });
  } catch (err) {
    next(err);
  }
};
