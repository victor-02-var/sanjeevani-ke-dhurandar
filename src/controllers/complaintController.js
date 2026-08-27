import { supabaseAdmin as supabase } from '../config/supabase.js';
import { cloudinary } from '../config/cloudinary.js';
import { extractGpsFromMetadata, verifyGarbageImage } from '../services/imageService.js';
import { seedInitialTimeline } from './timelineController.js';

// 0. POST /api/complaints/verify-image - Background AI image verification (No Cloudinary Upload)
export const verifyImageOnly = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload an image file.' });
    }

    const imageBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;

    console.log('⌛ [Background] Verifying image content with Gemini AI Vision...');
    const verification = await verifyGarbageImage(imageBuffer, mimeType);

    if (!verification.isGarbage) {
      return res.status(422).json({
        success: false,
        error: 'Invalid Image Upload',
        reason: verification.reason || 'The uploaded image does not appear to show municipal waste.',
        detectedCategory: verification.category
      });
    }

    console.log('⌛ [Background] Extracting EXIF GPS coordinates...');
    const exifGps = extractGpsFromMetadata(imageBuffer);

    res.status(200).json({
      success: true,
      verification,
      exifGps
    });
  } catch (err) {
    next(err);
  }
};

// 1. POST /api/complaints - Citizen submits a new complaint (Uploads image to Cloudinary & saves record)
export const createComplaint = async (req, res, next) => {
  try {
    const citizen_id = req.user.id;
    const { 
      description, 
      category, 
      ai_confidence, 
      ai_reason, 
      gps_source,
      latitude,
      longitude 
    } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Please upload an image of the waste site.' });
    }

    const finalLat = latitude ? parseFloat(latitude) : null;
    const finalLng = longitude ? parseFloat(longitude) : null;

    if (!finalLat || !finalLng) {
      return res.status(400).json({
        error: 'Location coordinates missing. Please enable GPS on your camera or select a location on the map.'
      });
    }

    console.log('⌛ [Submit] Uploading image to Cloudinary...');
    const imageBuffer = req.file.buffer;
    const uploadPromise = new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'waste_complaints' },
        (error, result) => {
          if (error) reject(error);
          else resolve(result.secure_url);
        }
      );
      stream.end(imageBuffer);
    });

    const image_url = await uploadPromise;

    const { data: newComplaint, error } = await supabase
      .from('complaints')
      .insert([
        {
          latitude: finalLat,
          longitude: finalLng,
          description: description || ai_reason || 'Municipal waste complaint',
          image_url,
          citizen_id,
          status: 'Open',
          priority: 'High',
          category: category || 'Roadside Litter',
          ai_confidence: ai_confidence ? parseFloat(ai_confidence) : 0.95,
          ai_reason: ai_reason || 'Verified waste',
          gps_source: gps_source || 'USER_PIN'
        }
      ])
      .select()
      .single();

    if (error) throw error;

    // Seed sample timeline in background (non-blocking)
    seedInitialTimeline(newComplaint.id).catch((e) => console.warn('Timeline seed failed:', e.message));

    res.status(201).json({
      success: true,
      message: 'Complaint verified and submitted successfully!',
      complaint: newComplaint
    });
  } catch (err) {
    next(err);
  }
};

// 2. GET /api/complaints/my-complaints - Get citizen's own complaints
export const getCitizenComplaints = async (req, res, next) => {
  try {
    const citizen_id = req.user.id;

    const { data: complaints, error } = await supabase
      .from('complaints')
      .select('id, latitude, longitude, description, image_url, resolved_image_url, status, priority, category, gps_source, created_at, resolved_at, assigned_driver_id')
      .eq('citizen_id', citizen_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      count: complaints.length,
      complaints
    });
  } catch (err) {
    next(err);
  }
};

// 3. GET /api/complaints/admin/all - Fetch all complaints + Citizen details
export const getAllComplaintsForAdmin = async (req, res, next) => {
  try {
    const { data: complaints, error } = await supabase
      .from('complaints')
      .select(`
        id,
        latitude,
        longitude,
        description,
        image_url,
        status,
        priority,
        category,
        ai_confidence,
        ai_reason,
        gps_source,
        assigned_driver_id,
        created_at,
        profiles:profiles!complaints_citizen_id_fkey (
          id,
          full_name,
          email
        ),
        assigned_driver:profiles!complaints_assigned_driver_id_fkey (
          id,
          full_name,
          email
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      count: complaints.length,
      complaints
    });
  } catch (err) {
    next(err);
  }
};

// 4. PATCH /api/complaints/:id/assign - Assign Driver to Complaint
export const assignDriverToComplaint = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { driverId } = req.body;

    if (!driverId) {
      return res.status(400).json({ error: 'Driver ID is required for assignment.' });
    }

    // The admin fleet list historically submitted a vehicle UUID. Resolve it
    // to the profile UUID required by complaints.assigned_driver_id.
    let assignedDriverId = driverId;
    const { data: driverProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', driverId)
      .maybeSingle();

    if (!driverProfile) {
      const { data: vehicle, error: vehicleError } = await supabase
        .from('vehicles')
        .select('driver_id')
        .eq('id', driverId)
        .maybeSingle();

      if (vehicleError) throw vehicleError;
      if (!vehicle?.driver_id) {
        return res.status(400).json({ error: 'Selected driver or vehicle was not found.' });
      }

      assignedDriverId = vehicle.driver_id;
    }

    const { data: updatedComplaint, error } = await supabase
      .from('complaints')
      .update({
        assigned_driver_id: assignedDriverId,
        status: 'Assigned'
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: `Complaint assigned to driver ${assignedDriverId} successfully.`,
      complaint: updatedComplaint
    });
  } catch (err) {
    next(err);
  }
};

// 5. PATCH /api/complaints/:id/status - Update Status with Resolution Proof
export const updateComplaintStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required.' });
    }

    const updatePayload = { status };
    if (status.toLowerCase() === 'resolved') {
      if (!req.file) {
        return res.status(400).json({ error: 'Proof photo of the cleaned site is required to resolve this complaint.' });
      }

      console.log('⌛ Uploading resolution proof image to Cloudinary...');
      const imageBuffer = req.file.buffer;
      const uploadPromise = new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'resolved_complaints' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result.secure_url);
          }
        );
        stream.end(imageBuffer);
      });

      const resolved_image_url = await uploadPromise;
      updatePayload.resolved_image_url = resolved_image_url;
      updatePayload.resolved_at = new Date().toISOString();
    }

    if (notes) {
      updatePayload.resolution_notes = notes;
    }

    const { data: updatedComplaint, error } = await supabase
      .from('complaints')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: `Complaint status updated to ${status}.`,
      complaint: updatedComplaint
    });
  } catch (err) {
    next(err);
  }
};