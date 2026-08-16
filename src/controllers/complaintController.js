import { supabase } from '../config/supabase.js';
import { cloudinary } from '../config/cloudinary.js';
import { extractGpsFromMetadata, verifyGarbageImage } from '../services/imageService.js';

// 1. POST /api/complaints - Citizen submits a new complaint
export const createComplaint = async (req, res, next) => {
  try {
    const citizen_id = req.user.id;
    const { description } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Please upload an image of the waste site.' });
    }

    const imageBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;

    console.log('⌛ Verifying image content with Gemini AI Vision...');
    const verification = await verifyGarbageImage(imageBuffer, mimeType);

    if (!verification.isGarbage) {
      return res.status(422).json({
        success: false,
        error: 'Invalid Image Upload',
        reason: verification.reason,
        detectedCategory: verification.category
      });
    }

    console.log('⌛ Extracting EXIF GPS coordinates...');
    const exifGps = extractGpsFromMetadata(imageBuffer);

    const finalLat = exifGps.latitude || (req.body.latitude ? parseFloat(req.body.latitude) : null);
    const finalLng = exifGps.longitude || (req.body.longitude ? parseFloat(req.body.longitude) : null);

    if (!finalLat || !finalLng) {
      return res.status(400).json({
        error: 'Location coordinates missing. Please enable GPS on your camera or select a location on the map.'
      });
    }

    console.log('⌛ Uploading image to Cloudinary...');
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
          description: description || verification.reason,
          image_url,
          citizen_id,
          status: 'Open',
          priority: 'High',
          category: verification.category,
          ai_confidence: verification.confidence,
          ai_reason: verification.reason,
          gps_source: exifGps.hasMetadataGps ? 'EXIF_METADATA' : 'USER_PIN'
        }
      ])
      .select()
      .single();

    if (error) throw error;

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
        citizens (
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

    const { data: updatedComplaint, error } = await supabase
      .from('complaints')
      .update({
        assigned_driver_id: driverId,
        status: 'Assigned'
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: `Complaint assigned to driver ${driverId} successfully.`,
      complaint: updatedComplaint
    });
  } catch (err) {
    next(err);
  }
};

// 5. PATCH /api/complaints/:id/status - Update Status (Open, Assigned, Resolved)
// export const updateComplaintStatus = async (req, res, next) => {
//   try {
//     const { id } = req.params;
//     const { status, notes } = req.body;

//     if (!status) {
//       return res.status(400).json({ error: 'Status is required.' });
//     }

//     const updatePayload = { status };
//     if (status.toLowerCase() === 'resolved') {
//       updatePayload.resolved_at = new Date().toISOString();
//     }
//     if (notes) {
//       updatePayload.resolution_notes = notes;
//     }

//     const { data: updatedComplaint, error } = await supabase
//       .from('complaints')
//       .update(updatePayload)
//       .eq('id', id)
//       .select()
//       .single();

//     if (error) throw error;

//     res.status(200).json({
//       success: true,
//       message: `Complaint status updated to ${status}.`,
//       complaint: updatedComplaint
//     });
//   } catch (err) {
//     next(err);
//   }
// };

// 5. PATCH /api/complaints/:id/status - Update Status (Open, Assigned, Resolved) with Resolution Image Proof
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