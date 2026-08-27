import { supabaseAdmin as supabase } from '../config/supabase.js';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import crypto from 'crypto';

// Secret key for HMAC signature verification of carbon card QR codes
const QR_SECRET = process.env.JWT_SECRET || 'civicsync_secure_carbon_points_key_2026';

// Points rules
const POINTS_PER_DAY = 100;
const WEEKLY_STREAK_BONUS = 50;   // every 7-consecutive-day streak
const MONTHLY_STREAK_BONUS = 150; // every 30-consecutive-day streak

// In-memory fallback store for redemptions if table is being created
const inMemoryRedemptions = new Map();

/**
 * Generate a cryptographically signed non-sensitive QR payload
 */
export function generateSecureQRPayload(citizenId, name, netPoints) {
  const cardId = `CARD-${citizenId.slice(0, 8).toUpperCase()}`;
  const validUntil = Date.now() + (24 * 60 * 60 * 1000); // 24 hours validity
  const rawData = `${citizenId}:${cardId}:${netPoints}:${validUntil}`;
  const sig = crypto.createHmac('sha256', QR_SECRET).update(rawData).digest('hex').slice(0, 16);

  return JSON.stringify({
    title: "CivicSync Carbon Card",
    card_id: cardId,
    name: name ? name.split(' ')[0] : 'Citizen',
    verify_url: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/carbon-points/external-verify`,
    v: 1,
    cid: citizenId,
    pts: netPoints,
    exp: validUntil,
    sig: sig,
  });
}

/**
 * Verify cryptographic signature of a QR payload
 */
export function verifyQRPayload(payloadStr) {
  try {
    const data = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
    const { cid, card, pts, exp, sig } = data;

    if (!cid || !card || pts === undefined || !exp || !sig) {
      return { valid: false, reason: 'Malformed payload structure' };
    }

    if (Date.now() > exp) {
      return { valid: false, reason: 'QR Code signature has expired. Please refresh card in app.' };
    }

    const rawData = `${cid}:${card}:${pts}:${exp}`;
    const expectedSig = crypto.createHmac('sha256', QR_SECRET).update(rawData).digest('hex').slice(0, 16);

    if (sig === expectedSig) {
      return { valid: true, citizenId: cid, cardId: card, points: pts };
    } else {
      return { valid: false, reason: 'Invalid digital signature. QR code has been tampered with.' };
    }
  } catch (err) {
    return { valid: false, reason: 'Invalid JSON payload format' };
  }
}

/**
 * Calculate earned carbon points for a citizen strictly from vehicle_scan_logs.
 */
function computePoints(scanDates) {
  if (!scanDates.length) return { total: 0, base: 0, weeklyBonus: 0, monthlyBonus: 0, streak: 0, totalDays: 0 };

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

  return { total, base, weeklyBonus, monthlyBonus, streak: maxStreak, totalDays };
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
  if (points >= 10000) return { label: 'PLATINUM', rebate: '5%' };
  if (points >= 5000)  return { label: 'GOLD',     rebate: '3%' };
  if (points >= 2000)  return { label: 'SILVER',   rebate: '2%' };
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
    const { total, base, weeklyBonus, monthlyBonus, streak, totalDays } = computePoints(dates);

    // Synchronize points balance: net = earned - redeemed
    const redeemedSum = await getRedeemedPointsSum(citizenId);
    const netPoints = Math.max(0, total - redeemedSum);
    const tier = getTier(netPoints);

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
    const secureQrPayload = generateSecureQRPayload(citizenId, citizenName, netPoints);

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
      total_points: netPoints,
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
    const { qr_payload, card_id, citizen_id } = req.body;

    let cid = citizen_id;
    let verifiedPoints = null;
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
      // Find citizen from card_id prefix
      const cleanCardId = card_id.replace('CARD-', '').toLowerCase();
      const { data: profiles } = await supabase.from('profiles').select('id, full_name');
      const found = (profiles || []).find(p => p.id.toLowerCase().startsWith(cleanCardId));
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

    // Live calculation of synchronized net points
    const { data: scans } = await supabase
      .from('vehicle_scan_logs')
      .select('scan_timestamp')
      .eq('citizen_id', cid);

    const dates = (scans || []).map(s => s.scan_timestamp);
    const { total } = computePoints(dates);
    const redeemedSum = await getRedeemedPointsSum(cid);
    const netPoints = Math.max(0, total - redeemedSum);
    const tier = getTier(netPoints);

    res.status(200).json({
      success: true,
      valid: true,
      signature_verified: signatureValid,
      citizen_id_masked: cid.slice(0, 4) + '****' + cid.slice(-4),
      card_id: `CARD-${cid.slice(0, 8).toUpperCase()}`,
      verified_points_balance: netPoints,
      tier: tier.label,
      max_rebate_percentage: tier.rebate,
      eligible_benefits: [
        { type: 'PROPERTY_TAX', title: 'Property Tax Rebate', min_points: 100, max_discount_inr: 500 },
        { type: 'WATER_TAX', title: 'Water Bill Rebate', min_points: 50, max_discount_inr: 250 },
        { type: 'BUS_PASS', title: 'Municipal Bus Pass Discount', min_points: 75, max_discount_inr: 300 },
      ],
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/carbon-points/claim-benefit - External / Citizen claim endpoint
export const claimCarbonPointsBenefit = async (req, res, next) => {
  try {
    const { qr_payload, points_to_claim, benefit_type, bill_reference } = req.body;

    let cid = req.user?.id || null;
    let cardId = null;

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
      cardId = verification.cardId;
    }

    if (!cid) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Valid QR payload or citizen auth token is required.',
      });
    }

    const claimPts = parseInt(points_to_claim, 10);
    if (isNaN(claimPts) || claimPts <= 0) {
      return res.status(400).json({ success: false, error: 'points_to_claim must be a positive number.' });
    }

    // Verify current net available points
    const { data: scans } = await supabase
      .from('vehicle_scan_logs')
      .select('scan_timestamp')
      .eq('citizen_id', cid);

    const dates = (scans || []).map(s => s.scan_timestamp);
    const { total } = computePoints(dates);
    const redeemedSum = await getRedeemedPointsSum(cid);
    const currentNetPoints = Math.max(0, total - redeemedSum);

    if (claimPts > currentNetPoints) {
      return res.status(400).json({
        success: false,
        error: 'Insufficient Points',
        message: `Requested ${claimPts} pts exceeds available balance of ${currentNetPoints} pts.`,
      });
    }

    const discountInr = (claimPts * 1.0).toFixed(2); // 1 point = 1 INR discount
    const voucherCode = `REDEEM-${(benefit_type || 'BILL').toUpperCase()}-${Date.now().toString().slice(-6)}`;
    if (!cardId) cardId = `CARD-${cid.slice(0, 8).toUpperCase()}`;

    const redemptionRecord = {
      id: `RED-${Date.now()}`,
      citizen_id: cid,
      card_id: cardId,
      benefit_type: benefit_type || 'BILL_PAYMENT',
      points_claimed: claimPts,
      discount_amount: parseFloat(discountInr),
      bill_reference: bill_reference || 'N/A',
      voucher_code: voucherCode,
      status: 'REDEEMED',
      created_at: new Date().toISOString(),
    };

    // Insert into Supabase database
    try {
      await supabase.from('carbon_redemptions').insert([{
        citizen_id: cid,
        card_id: cardId,
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

    const updatedRemainingPoints = currentNetPoints - claimPts;

    res.status(200).json({
      success: true,
      message: `Successfully claimed ${claimPts} Carbon Points for ${benefit_type || 'bill payment'}!`,
      voucher_code: voucherCode,
      points_claimed: claimPts,
      discount_amount_inr: parseFloat(discountInr),
      remaining_points_balance: updatedRemainingPoints,
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
