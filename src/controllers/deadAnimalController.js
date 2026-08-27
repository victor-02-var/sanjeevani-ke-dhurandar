import { supabaseAdmin as supabase } from '../config/supabase.js';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import ExifParser from 'exif-parser';

// In-memory fallback store if database table is being created
const inMemoryReports = new Map();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer memory storage configuration
const storage = multer.memoryStorage();
export const uploadDeadAnimalMulter = multer({
  storage: storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp', 'image/heic'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, WebP and HEIC images are allowed.'));
    }
  },
});

// Helper: Upload buffer to Cloudinary
const uploadToCloudinary = (buffer) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: 'civicsync/dead_animals' },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

// Helper: Extract GPS EXIF coordinates from image buffer
function extractExifLocation(buffer) {
  try {
    const parser = ExifParser.create(buffer);
    const result = parser.parse();
    if (result && result.tags) {
      const lat = result.tags.GPSLatitude;
      const lng = result.tags.GPSLongitude;
      if (lat !== undefined && lng !== undefined && !isNaN(lat) && !isNaN(lng)) {
        return {
          latitude: parseFloat(lat),
          longitude: parseFloat(lng),
          hasExifGPS: true,
        };
      }
    }
  } catch (e) {
    console.log('EXIF parsing skipped/not found:', e.message);
  }
  return null;
}

// POST /api/dead-animal-reports/upload-image - Upload photo & extract EXIF GPS location
export const uploadDeadAnimalImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    // 1. Attempt to extract EXIF location from buffer
    const extractedGPS = extractExifLocation(req.file.buffer);

    // 2. Upload photo to Cloudinary
    const cloudinaryResult = await uploadToCloudinary(req.file.buffer);

    res.status(200).json({
      success: true,
      message: 'Photo uploaded successfully',
      image_url: cloudinaryResult.secure_url,
      cloudinary_id: cloudinaryResult.public_id,
      extracted_gps: extractedGPS, // { latitude, longitude, hasExifGPS: true } or null
    });
  } catch (err) {
    console.error('Dead animal photo upload error:', err);
    next(err);
  }
};

// POST /api/dead-animal-reports - Citizen registers a dead animal complaint
export const createDeadAnimalReport = async (req, res, next) => {
  try {
    const {
      image_url,
      latitude,
      longitude,
      location_address,
      description,
      citizen_name,
      citizen_phone,
      citizen_email,
    } = req.body;

    const citizen_id = req.user?.id || null;

    if (!image_url || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        error: 'image_url, latitude, and longitude are required.'
      });
    }

    const latNum = parseFloat(latitude);
    const lngNum = parseFloat(longitude);

    if (isNaN(latNum) || isNaN(lngNum)) {
      return res.status(400).json({ error: 'Invalid latitude or longitude format.' });
    }

    // Extract citizen details from profiles table if available
    let citizenFullName = citizen_name || req.user?.full_name || null;
    let citizenEmailAddress = citizen_email || req.user?.email || null;
    let citizenPhoneNumber = citizen_phone || null;

    if (citizen_id) {
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name, email, phone')
          .eq('id', citizen_id)
          .maybeSingle();

        if (profile) {
          if (!citizenFullName && profile.full_name) citizenFullName = profile.full_name;
          if (!citizenEmailAddress && profile.email) citizenEmailAddress = profile.email;
          if (!citizenPhoneNumber && profile.phone) citizenPhoneNumber = profile.phone;
        }
      } catch (e) {
        console.warn('Profile lookup notice:', e.message);
      }
    }

    if (!citizenFullName) citizenFullName = 'Anonymous Citizen';

    const newReportData = {
      id: `DAR-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      citizen_id,
      citizen_name: citizenFullName,
      citizen_phone: citizenPhoneNumber,
      citizen_email: citizenEmailAddress,
      image_url,
      latitude: latNum,
      longitude: lngNum,
      location_address: location_address || `${latNum.toFixed(4)}, ${lngNum.toFixed(4)}`,
      description: description || 'Dead animal alert reported on locality road.',
      status: 'Pending',
      assigned_driver_name: null,
      assigned_driver_id: null,
      created_at: new Date().toISOString(),
      resolved_at: null,
    };

    // Store in Supabase database
    let createdReport = newReportData;
    try {
      const { data, error } = await supabase
        .from('dead_animal_reports')
        .insert([{
          citizen_id,
          citizen_name: newReportData.citizen_name,
          citizen_phone: newReportData.citizen_phone,
          citizen_email: newReportData.citizen_email,
          image_url,
          latitude: latNum,
          longitude: lngNum,
          location_address: newReportData.location_address,
          description: newReportData.description,
          status: 'Pending',
        }])
        .select()
        .single();

      if (error) {
        console.error('Dead animal DB insert error:', error.message, error.details, error.hint);
      }
      if (!error && data) {
        createdReport = data;
      }
    } catch (e) {
      console.error('Database insert exception:', e.message);
    }

    // Keep in memory map as fallback
    inMemoryReports.set(createdReport.id, createdReport);

    res.status(201).json({
      success: true,
      message: 'Dead animal complaint registered successfully! Sanitation team notified.',
      report: createdReport,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/dead-animal-reports/me - Citizen fetches their own dead animal reports
export const getMyDeadAnimalReports = async (req, res, next) => {
  try {
    const citizenId = req.user?.id || null;
    const citizenEmail = req.user?.email || null;
    const citizenName = req.user?.full_name || null;
    const citizenPhone = req.user?.phone || null;
    console.log('[Dead Animal /me] citizenId =', citizenId, '| email =', citizenEmail, '| name =', citizenName, '| phone =', citizenPhone);
    let dbReports = [];

    if (citizenId) {
      try {
        // Primary query: match by citizen_id
        const { data: byIdData, error: byIdError } = await supabase
          .from('dead_animal_reports')
          .select('*')
          .eq('citizen_id', citizenId)
          .order('created_at', { ascending: false });

        if (byIdError) {
          console.error('[Dead Animal /me] DB citizen_id query error:', byIdError.message);
        }
        if (!byIdError && byIdData) {
          dbReports = byIdData;
          console.log('[Dead Animal /me] DB by citizen_id returned', byIdData.length, 'reports');
        }

        // Fallback: Also find reports where citizen_id is null but email matches
        if (citizenEmail) {
          const { data: byEmailData, error: byEmailError } = await supabase
            .from('dead_animal_reports')
            .select('*')
            .is('citizen_id', null)
            .eq('citizen_email', citizenEmail)
            .order('created_at', { ascending: false });

          if (!byEmailError && byEmailData && byEmailData.length > 0) {
            console.log('[Dead Animal /me] DB by email fallback returned', byEmailData.length, 'orphaned reports');
            dbReports = [...dbReports, ...byEmailData];
            for (const orphan of byEmailData) {
              supabase.from('dead_animal_reports').update({ citizen_id: citizenId }).eq('id', orphan.id).then(() => {}).catch(() => {});
            }
          }
        }

        // Second fallback: match by citizen_name
        if (citizenName && dbReports.length === 0) {
          const { data: byNameData, error: byNameError } = await supabase
            .from('dead_animal_reports')
            .select('*')
            .is('citizen_id', null)
            .eq('citizen_name', citizenName)
            .order('created_at', { ascending: false });

          if (!byNameError && byNameData && byNameData.length > 0) {
            console.log('[Dead Animal /me] DB by name fallback returned', byNameData.length, 'orphaned reports');
            dbReports = [...dbReports, ...byNameData];
            for (const orphan of byNameData) {
              supabase.from('dead_animal_reports').update({ citizen_id: citizenId }).eq('id', orphan.id).then(() => {}).catch(() => {});
            }
          }
        }

        // Third fallback: match by citizen_phone
        if (citizenPhone && dbReports.length === 0) {
          const { data: byPhoneData, error: byPhoneError } = await supabase
            .from('dead_animal_reports')
            .select('*')
            .is('citizen_id', null)
            .eq('citizen_phone', citizenPhone)
            .order('created_at', { ascending: false });

          if (!byPhoneError && byPhoneData && byPhoneData.length > 0) {
            console.log('[Dead Animal /me] DB by phone fallback returned', byPhoneData.length, 'orphaned reports');
            dbReports = [...dbReports, ...byPhoneData];
            for (const orphan of byPhoneData) {
              supabase.from('dead_animal_reports').update({ citizen_id: citizenId }).eq('id', orphan.id).then(() => {}).catch(() => {});
            }
          }
        }
      } catch (e) {
        console.error('[Dead Animal /me] DB exception:', e.message);
      }
    } else {
      console.warn('[Dead Animal /me] No citizen_id found in req.user — user may not be authenticated');
    }

    // Include memory map entries for this citizen
    const memoryArr = Array.from(inMemoryReports.values()).filter(
      r => (citizenId && r.citizen_id === citizenId) ||
           (citizenEmail && r.citizen_email === citizenEmail) ||
           (citizenName && r.citizen_name === citizenName) ||
           (citizenPhone && r.citizen_phone === citizenPhone)
    );
    console.log('[Dead Animal /me] In-memory matches:', memoryArr.length);

    // Deduplicate by id
    const combinedMap = new Map();
    dbReports.forEach(r => combinedMap.set(r.id, r));
    memoryArr.forEach(r => combinedMap.set(r.id, r));

    const finalReports = Array.from(combinedMap.values()).sort(
      (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );

    res.status(200).json({
      success: true,
      count: finalReports.length,
      reports: finalReports,
    });
  } catch (err) {
    console.error('[Dead Animal /me] Unhandled error:', err);
    next(err);
  }
};

// GET /api/dead-animal-reports/all - Admin fetches all dead animal complaints
export const getAllDeadAnimalReports = async (req, res, next) => {
  try {
    let dbReports = [];
    try {
      const { data, error } = await supabase
        .from('dead_animal_reports')
        .select('*')
        .order('created_at', { ascending: false });

      if (!error && data) {
        dbReports = data;
      }
    } catch (e) {
      // ignore
    }

    // Combine with memory store
    const memoryArr = Array.from(inMemoryReports.values());
    const combinedMap = new Map();

    dbReports.forEach(r => combinedMap.set(r.id, r));
    memoryArr.forEach(r => combinedMap.set(r.id, r));

    const finalReports = Array.from(combinedMap.values()).sort(
      (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );

    res.status(200).json({
      success: true,
      count: finalReports.length,
      reports: finalReports,
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/dead-animal-reports/:id/status - Admin updates status & assigns driver
export const updateDeadAnimalReportStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, assigned_driver_name, assigned_driver_id } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'Report ID is required.' });
    }

    const isResolved = status === 'Resolved' || status === 'Cleaned';
    const now = new Date().toISOString();

    const updateObj = {
      ...(status && { status }),
      ...(assigned_driver_name !== undefined && { assigned_driver_name }),
      ...(assigned_driver_id !== undefined && { assigned_driver_id }),
      ...(isResolved && { resolved_at: now }),
    };

    let updatedReport = null;

    try {
      const { data, error } = await supabase
        .from('dead_animal_reports')
        .update(updateObj)
        .eq('id', id)
        .select()
        .single();

      if (!error && data) {
        updatedReport = data;
      }
    } catch (e) {
      // ignore
    }

    // Update in-memory map
    if (inMemoryReports.has(id)) {
      const existing = inMemoryReports.get(id);
      const merged = { ...existing, ...updateObj };
      inMemoryReports.set(id, merged);
      if (!updatedReport) updatedReport = merged;
    }

    res.status(200).json({
      success: true,
      message: `Dead animal report status updated to "${status || 'Updated'}".`,
      report: updatedReport || { id, ...updateObj },
    });
  } catch (err) {
    next(err);
  }
};
