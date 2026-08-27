import { supabaseAdmin } from '../config/supabase.js';
import crypto from 'crypto';

// ==========================================
// DRIVER/VEHICLE: Generate QR Codes
// ==========================================

// POST /api/qr/generate - Driver generates QR code for a dustbin location
export const generateQRCode = async (req, res, next) => {
  try {
    const driverId = req.user?.id;
    const { bin_location_lat, bin_location_lng, bin_address, expires_in_hours } = req.body;

    if (!driverId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!bin_location_lat || !bin_location_lng) {
      return res.status(400).json({ error: 'Bin location coordinates are required.' });
    }

    // Get driver's vehicle
    const { data: vehicle, error: vehicleError } = await supabaseAdmin
      .from('vehicles')
      .select('id, driver_id, license_plate')
      .eq('driver_id', driverId)
      .maybeSingle();

    if (vehicleError || !vehicle) {
      return res.status(404).json({ error: 'No vehicle assigned to this driver.' });
    }

    // Generate unique QR code
    const qrCode = `CIVICSYNC-${Date.now()}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

    // Calculate expiration (default: 24 hours)
    const expiresAt = expires_in_hours
      ? new Date(Date.now() + expires_in_hours * 60 * 60 * 1000)
      : new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Insert QR code
    const { data: qrData, error: qrError } = await supabaseAdmin
      .from('dustbin_qr_codes')
      .insert([{
        qr_code: qrCode,
        vehicle_id: vehicle.id,
        driver_id: driverId,
        bin_location_lat: parseFloat(bin_location_lat),
        bin_location_lng: parseFloat(bin_location_lng),
        bin_address: bin_address || null,
        is_active: true,
        expires_at: expiresAt,
      }])
      .select()
      .single();

    if (qrError) throw qrError;

    res.status(201).json({
      message: 'QR code generated successfully.',
      qr_code: qrData,
      qr_string: qrCode,
      vehicle: {
        id: vehicle.id,
        license_plate: vehicle.license_plate,
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/qr/my-codes - Driver gets their generated QR codes
export const getMyQRCodes = async (req, res, next) => {
  try {
    const driverId = req.user?.id;

    const { data: qrCodes, error } = await supabaseAdmin
      .from('dustbin_qr_codes')
      .select(`
        id,
        qr_code,
        bin_location_lat,
        bin_location_lng,
        bin_address,
        is_active,
        generated_at,
        expires_at,
        vehicles (
          id,
          license_plate,
          driver_name
        )
      `)
      .eq('driver_id', driverId)
      .order('generated_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      count: qrCodes?.length || 0,
      qr_codes: qrCodes || [],
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/qr/:id/toggle - Driver toggles QR code active status
export const toggleQRCodeStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const driverId = req.user?.id;

    // Get QR code
    const { data: qrCode, error: fetchError } = await supabaseAdmin
      .from('dustbin_qr_codes')
      .select('id, is_active, driver_id')
      .eq('id', id)
      .single();

    if (fetchError || !qrCode) {
      return res.status(404).json({ error: 'QR code not found.' });
    }

    // Verify ownership
    if (qrCode.driver_id !== driverId) {
      return res.status(403).json({ error: 'You can only manage your own QR codes.' });
    }

    // Toggle status
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('dustbin_qr_codes')
      .update({ is_active: !qrCode.is_active })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.status(200).json({
      message: `QR code ${updated.is_active ? 'activated' : 'deactivated'} successfully.`,
      qr_code: updated,
    });
  } catch (err) {
    next(err);
  }
};

// ==========================================
// CITIZEN: Scan QR Code and Submit Proof
// ==========================================

// GET /api/qr/validate/:qr_code - Validate QR code before scanning
export const validateQRCode = async (req, res, next) => {
  try {
    const { qr_code } = req.params;

    const { data: qrData, error } = await supabaseAdmin
      .from('dustbin_qr_codes')
      .select(`
        id,
        qr_code,
        bin_location_lat,
        bin_location_lng,
        bin_address,
        is_active,
        expires_at,
        vehicles (
          id,
          license_plate,
          driver_name
        )
      `)
      .eq('qr_code', qr_code)
      .maybeSingle();

    if (error) throw error;

    if (!qrData) {
      return res.status(404).json({ error: 'Invalid QR code.' });
    }

    if (!qrData.is_active) {
      return res.status(400).json({ error: 'This QR code has been deactivated.' });
    }

    if (qrData.expires_at && new Date(qrData.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This QR code has expired.' });
    }

    res.status(200).json({
      valid: true,
      qr_data: qrData,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/qr/scan - Citizen scans QR and submits photo + location
export const submitQRScan = async (req, res, next) => {
  try {
    const citizenId = req.user?.id;
    const { qr_code, scan_latitude, scan_longitude, scan_address, device_info } = req.body;

    if (!citizenId) {
      return res.status(401).json({ error: 'Unauthorized. Please log in.' });
    }

    if (!qr_code || !scan_latitude || !scan_longitude) {
      return res.status(400).json({ error: 'QR code and location are required.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Garbage photo is required.' });
    }

    // Validate QR code
    const { data: qrData, error: qrError } = await supabaseAdmin
      .from('dustbin_qr_codes')
      .select('id, qr_code, is_active, expires_at')
      .eq('qr_code', qr_code)
      .maybeSingle();

    if (qrError || !qrData) {
      return res.status(404).json({ error: 'Invalid QR code.' });
    }

    if (!qrData.is_active) {
      return res.status(400).json({ error: 'This QR code is no longer active.' });
    }

    if (qrData.expires_at && new Date(qrData.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This QR code has expired.' });
    }

    // Get citizen details
    const { data: citizen } = await supabaseAdmin
      .from('profiles')
      .select('full_name, email')
      .eq('id', citizenId)
      .single();

    // Upload photo to Supabase Storage
    const fileName = `scan_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.jpg`;
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('qr-scan-photos')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabaseAdmin.storage
      .from('qr-scan-photos')
      .getPublicUrl(fileName);

    // Save scan log
    const { data: scanLog, error: scanError } = await supabaseAdmin
      .from('qr_scan_logs')
      .insert([{
        qr_code_id: qrData.id,
        citizen_id: citizenId,
        citizen_name: citizen?.full_name || 'Unknown',
        citizen_email: citizen?.email || '',
        garbage_image_url: publicUrlData.publicUrl,
        scan_latitude: parseFloat(scan_latitude),
        scan_longitude: parseFloat(scan_longitude),
        scan_address: scan_address || null,
        device_info: device_info || null,
        verified_by_admin: false,
      }])
      .select()
      .single();

    if (scanError) throw scanError;

    res.status(201).json({
      success: true,
      message: 'QR scan recorded successfully! Thank you for your contribution.',
      scan_log: scanLog,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/qr/my-scans - Citizen gets their scan history
export const getMyScanHistory = async (req, res, next) => {
  try {
    const citizenId = req.user?.id;

    const { data: scans, error } = await supabaseAdmin
      .from('qr_scan_logs')
      .select(`
        id,
        garbage_image_url,
        scan_latitude,
        scan_longitude,
        scan_address,
        scan_timestamp,
        verified_by_admin,
        admin_notes,
        dustbin_qr_codes (
          qr_code,
          bin_address,
          vehicles (
            license_plate,
            driver_name
          )
        )
      `)
      .eq('citizen_id', citizenId)
      .order('scan_timestamp', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      count: scans?.length || 0,
      scans: scans || [],
    });
  } catch (err) {
    next(err);
  }
};

// ==========================================
// ADMIN: View and Manage All Scans
// ==========================================

// GET /api/qr/admin/all-scans - Admin views all scan logs
export const getAllScanLogs = async (req, res, next) => {
  try {
    const { data: scans, error } = await supabaseAdmin
      .from('qr_scan_logs')
      .select(`
        id,
        citizen_name,
        citizen_email,
        garbage_image_url,
        scan_latitude,
        scan_longitude,
        scan_address,
        scan_timestamp,
        verified_by_admin,
        admin_notes,
        device_info,
        dustbin_qr_codes (
          qr_code,
          bin_address,
          bin_location_lat,
          bin_location_lng,
          vehicles (
            id,
            license_plate,
            driver_name
          )
        )
      `)
      .order('scan_timestamp', { ascending: false })
      .limit(500); // Limit for performance

    if (error) throw error;

    res.status(200).json({
      count: scans?.length || 0,
      scans: scans || [],
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/qr/admin/all-qr-codes - Admin views all QR codes
export const getAllQRCodes = async (req, res, next) => {
  try {
    const { data: qrCodes, error } = await supabaseAdmin
      .from('dustbin_qr_codes')
      .select(`
        id,
        qr_code,
        bin_location_lat,
        bin_location_lng,
        bin_address,
        is_active,
        generated_at,
        expires_at,
        vehicles (
          id,
          license_plate,
          driver_name
        )
      `)
      .order('generated_at', { ascending: false });

    if (error) throw error;

    // Get scan count for each QR code
    const qrCodesWithStats = await Promise.all(
      qrCodes.map(async (qr) => {
        const { count } = await supabaseAdmin
          .from('qr_scan_logs')
          .select('id', { count: 'exact', head: true })
          .eq('qr_code_id', qr.id);

        return {
          ...qr,
          total_scans: count || 0,
        };
      })
    );

    res.status(200).json({
      count: qrCodesWithStats.length,
      qr_codes: qrCodesWithStats,
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/qr/admin/verify/:id - Admin verifies a scan
export const verifyScan = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { verified, admin_notes } = req.body;

    const { data: updated, error } = await supabaseAdmin
      .from('qr_scan_logs')
      .update({
        verified_by_admin: verified !== undefined ? verified : true,
        admin_notes: admin_notes || null,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      message: 'Scan verification updated successfully.',
      scan_log: updated,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/qr/admin/stats - Admin gets QR system statistics
export const getQRStats = async (req, res, next) => {
  try {
    // Total QR codes
    const { count: totalQRCodes } = await supabaseAdmin
      .from('dustbin_qr_codes')
      .select('id', { count: 'exact', head: true });

    // Active QR codes
    const { count: activeQRCodes } = await supabaseAdmin
      .from('dustbin_qr_codes')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true);

    // Total scans
    const { count: totalScans } = await supabaseAdmin
      .from('qr_scan_logs')
      .select('id', { count: 'exact', head: true });

    // Verified scans
    const { count: verifiedScans } = await supabaseAdmin
      .from('qr_scan_logs')
      .select('id', { count: 'exact', head: true })
      .eq('verified_by_admin', true);

    // Scans today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { count: scansToday } = await supabaseAdmin
      .from('qr_scan_logs')
      .select('id', { count: 'exact', head: true })
      .gte('scan_timestamp', today.toISOString());

    res.status(200).json({
      stats: {
        total_qr_codes: totalQRCodes || 0,
        active_qr_codes: activeQRCodes || 0,
        total_scans: totalScans || 0,
        verified_scans: verifiedScans || 0,
        pending_verification: (totalScans || 0) - (verifiedScans || 0),
        scans_today: scansToday || 0,
      },
    });
  } catch (err) {
    next(err);
  }
};
