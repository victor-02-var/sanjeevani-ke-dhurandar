import { supabaseAdmin } from '../config/supabase.js';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';

// Configure Cloudinary (ensure environment variables are set in your .env)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer configuration for memory storage
const storage = multer.memoryStorage();
export const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and WebP are allowed.'));
    }
  },
});

// Helper function to upload buffer to Cloudinary
const uploadToCloudinary = (buffer) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: 'civicsync/scans' },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

// POST /api/qr-scan/upload-image - Upload scan photo to Cloudinary
export const uploadScanImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const result = await uploadToCloudinary(req.file.buffer);

    res.status(200).json({
      message: 'Image uploaded successfully',
      url: result.secure_url,
      path: result.public_id,
    });
  } catch (err) {
    console.error('Cloudinary upload error:', err);
    next(err);
  }
};

// POST /api/qr/scan - Citizen scans vehicle QR code
export const logVehicleScan = async (req, res, next) => {
  try {
    const {
      vehicle_qr_code,
      garbage_image_url,
      scan_latitude,
      scan_longitude,
      scan_address,
      device_info
    } = req.body;

    const citizen_id = req.user?.id || null;

    if (!vehicle_qr_code || !garbage_image_url || !scan_latitude || !scan_longitude) {
      return res.status(400).json({
        error: 'vehicle_qr_code, garbage_image_url, scan_latitude, and scan_longitude are required.'
      });
    }

    // Find the vehicle by QR code
    const { data: vehicle, error: vehicleError } = await supabaseAdmin
      .from('vehicles')
      .select('id, license_plate, driver_id, driver_name, territory_name')
      .eq('vehicle_qr_code', vehicle_qr_code)
      .single();

    if (vehicleError || !vehicle) {
      return res.status(404).json({ error: 'Invalid QR code. Vehicle not found.' });
    }

    // Get citizen details if logged in
    let citizenName = 'Anonymous';
    let citizenEmail = null;
    if (citizen_id) {
      const { data: citizen } = await supabaseAdmin
        .from('profiles')
        .select('full_name, email')
        .eq('id', citizen_id)
        .single();
      citizenName = citizen?.full_name || 'Anonymous';
      citizenEmail = citizen?.email || null;
    }

    // Log the scan
    const { data: scanLog, error: scanError } = await supabaseAdmin
      .from('vehicle_scan_logs')
      .insert([{
        vehicle_id: vehicle.id,
        vehicle_qr_code: vehicle_qr_code,
        citizen_id: citizen_id,
        citizen_name: citizenName,
        citizen_email: citizenEmail,
        garbage_image_url,
        scan_latitude,
        scan_longitude,
        scan_address: scan_address || null,
        device_info: device_info || null,
        verified_by_admin: false
      }])
      .select()
      .single();

    if (scanError) {
      console.error('Scan log error:', scanError);
      return res.status(500).json({
        error: 'Failed to log scan.'
      });
    }

    const normTerritory = vehicle.territory_name || 'Zone 1 (ZONE A - North Territory)';
    const routeName = normTerritory.toUpperCase().includes('ZONE B') ? 'ROUTE-TRUCK-002' : 'ROUTE-TRUCK-001';

    res.status(201).json({
      message: 'Scan logged successfully!',
      scan: {
        id: scanLog.id,
        vehicle_license: vehicle.license_plate,
        driver_name: vehicle.driver_name || 'Assigned Driver',
        territory_name: normTerritory,
        route_name: routeName,
        scan_timestamp: scanLog.scan_timestamp,
        points_awarded: 50
      }
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/qr/vehicle/:qr_code - Get vehicle info from QR code (for scan page)
export const getVehicleByQR = async (req, res, next) => {
  try {
    const { qr_code } = req.params;

    const { data: vehicle, error } = await supabaseAdmin
      .from('vehicles')
      .select(`
        id,
        license_plate,
        territory_name,
        status,
        driver_name,
        profiles:driver_id (
          full_name,
          avatar_url
        )
      `)
      .eq('vehicle_qr_code', qr_code)
      .single();

    if (error || !vehicle) {
      return res.status(404).json({
        error: 'Vehicle not found with this QR code.'
      });
    }

    const normTerritory = vehicle.territory_name || 'Zone 1 (ZONE A - North Territory)';
    const routeName = normTerritory.toUpperCase().includes('ZONE B') ? 'ROUTE-TRUCK-002' : 'ROUTE-TRUCK-001';

    res.status(200).json({
      vehicle: {
        id: vehicle.id,
        license_plate: vehicle.license_plate,
        territory: normTerritory,
        route_name: routeName,
        status: vehicle.status || 'Active',
        driver_name: vehicle.driver_name || vehicle.profiles?.full_name || 'Assigned Driver'
      }
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/qr-scan/scans/my-vehicle - Vehicle authority sees scans of their vehicle
export const getMyVehicleScans = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const userRole = req.user?.role;
    const { page = 1, limit = 50, days = 30 } = req.query;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const offset = (page - 1) * limit;

    console.log('📊 Fetching vehicle scans for user:', userId, 'Role:', userRole);

    // Build query based on role
    let query = supabaseAdmin
      .from('vehicle_scan_logs')
      .select(`
        id,
        vehicle_id,
        vehicle_qr_code,
        citizen_id,
        citizen_name,
        citizen_email,
        garbage_image_url,
        scan_latitude,
        scan_longitude,
        scan_address,
        scan_timestamp,
        device_info,
        verified_by_admin,
        admin_notes,
        verification_timestamp,
        vehicles!inner (
          id,
          license_plate,
          driver_id,
          authority_id,
          driver_name,
          territory_name
        )
      `, { count: 'exact' })
      .order('scan_timestamp', { ascending: false })
      .range(offset, offset + limit - 1);

    // Filter by user role
    if (userRole === 'vehicle_authority') {
      // Vehicle authorities see scans for vehicles they manage
      query = query.eq('vehicles.authority_id', userId);
      console.log('🚛 Filtering by authority_id:', userId);
    } else if (userRole === 'driver') {
      // Drivers see scans for vehicles they drive
      query = query.eq('vehicles.driver_id', userId);
      console.log('🚗 Filtering by driver_id:', userId);
    } else {
      // For other roles, filter by driver_id (backward compatibility)
      query = query.eq('vehicles.driver_id', userId);
    }

    // Filter by date range
    if (days) {
      const dateThreshold = new Date();
      dateThreshold.setDate(dateThreshold.getDate() - parseInt(days));
      query = query.gte('scan_timestamp', dateThreshold.toISOString());
      console.log('📅 Filtering by date:', dateThreshold.toISOString());
    }

    const { data: scans, error, count } = await query;

    if (error) {
      console.error('❌ Scans error:', error);
      return res.status(500).json({ error: 'Failed to fetch scans.', details: error.message });
    }

    console.log('✅ Found', count, 'scans for user:', userId);

    res.status(200).json({
      scans: scans || [],
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        total_pages: Math.ceil(count / limit)
      }
    });
  } catch (err) {
    console.error('❌ Exception in getMyVehicleScans:', err);
    next(err);
  }
};

// GET /api/qr-scan/scans/all - Admin sees all scans
export const getAllScans = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, days = 7, vehicle_id, verified } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('vehicle_scan_logs')
      .select(`
        *,
        vehicles (
          license_plate,
          territory_name
        )
      `, { count: 'exact' })
      .order('scan_timestamp', { ascending: false })
      .range(offset, offset + limit - 1);

    if (vehicle_id) {
      query = query.eq('vehicle_id', vehicle_id);
    }

    if (verified !== undefined) {
      query = query.eq('verified_by_admin', verified === 'true');
    }

    if (days) {
      const dateThreshold = new Date();
      dateThreshold.setDate(dateThreshold.getDate() - parseInt(days));
      query = query.gte('scan_timestamp', dateThreshold.toISOString());
    }

    const { data: scans, error, count } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch scans.' });
    }

    res.status(200).json({
      scans: scans || [],
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        total_pages: Math.ceil(count / limit)
      }
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/qr/scans/:id/verify - Admin verifies a scan
export const verifyScan = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { verified, admin_notes } = req.body;

    const { data: scan, error } = await supabaseAdmin
      .from('vehicle_scan_logs')
      .update({
        verified_by_admin: verified,
        admin_notes: admin_notes || null,
        verification_timestamp: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to verify scan.' });
    }

    res.status(200).json({
      message: 'Scan verification updated.',
      scan
    });
  } catch (err) {
    next(err);
  }
};