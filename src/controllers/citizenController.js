import { extractGpsFromMetadata, verifyGarbageImage } from '../services/imageService.js';
import { supabaseAdmin as supabase } from '../config/supabase.js';

// POST /api/citizen/report-issue
export const submitGrievanceReport = async (req, res, next) => {
  try {
    // Multer stores the binary image in req.file.buffer
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload an image of the garbage site.' });
    }

    const imageBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;

    // 1. Verify if image is actually garbage using Gemini AI
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

    // 2. Extract Location Metadata from EXIF
    console.log('⌛ Extracting EXIF GPS coordinates...');
    const exifGps = extractGpsFromMetadata(imageBuffer);

    // Fallback: If no GPS in EXIF metadata, use user's manual pin input from req.body
    const finalLat = exifGps.latitude || parseFloat(req.body.latitude);
    const finalLng = exifGps.longitude || parseFloat(req.body.longitude);

    if (!finalLat || !finalLng) {
      return res.status(400).json({
        error: 'Location coordinates missing. Please enable location permissions on your camera or pick on map.'
      });
    }

    // 3. Upload photo to Supabase Storage Bucket
    const fileName = `report_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('garbage-reports')
      .upload(fileName, imageBuffer, { contentType: mimeType });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabase.storage
      .from('garbage-reports')
      .getPublicUrl(fileName);

    // 4. Save Report Entry into Supabase Database
    const { data: newReport, error: dbError } = await supabase
      .from('citizen_reports')
      .insert([
        {
          citizen_id: req.user?.id || null,
          image_url: publicUrlData.publicUrl,
          latitude: finalLat,
          longitude: finalLng,
          gps_source: exifGps.hasMetadataGps ? 'EXIF_METADATA' : 'USER_PIN',
          category: verification.category,
          ai_confidence: verification.confidence,
          ai_reason: verification.reason,
          status: 'Verified'
        }
      ])
      .select()
      .single();

    if (dbError) throw dbError;

    res.status(201).json({
      success: true,
      message: 'Grievance verified and logged successfully!',
      report: newReport
    });
  } catch (err) {
    next(err);
  }
};


// GET /api/citizen/profile - Get current citizen's profile
export const getCitizenProfile = async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Fetch profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, email, full_name, phone, address, avatar_url, role, is_active, created_at')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    if (profile.role !== 'citizen') {
      return res.status(403).json({ error: 'Not a citizen account.' });
    }

    // Fetch carbon card
    const { data: carbonCard } = await supabase
      .from('carbon_cards')
      .select('total_points, redeemed_points, available_points, tier, updated_at')
      .eq('citizen_id', userId)
      .maybeSingle();

    // Fetch complaint stats
    const { count: complaintsCount } = await supabase
      .from('complaints')
      .select('id', { count: 'exact', head: true })
      .eq('citizen_id', userId);

    const { data: citizenComplaints = [] } = await supabase
      .from('complaints')
      .select('status')
      .eq('citizen_id', userId);

    const resolvedCount = (citizenComplaints || []).filter((complaint) => {
      const status = String(complaint.status || '').trim().toLowerCase();
      return ['resolved', 'solved', 'closed', 'completed', 'cleaned', 'fixed', 'done'].includes(status);
    }).length;

    res.status(200).json({
      profile: {
        ...profile,
        carbon_card: carbonCard || { total_points: 0, available_points: 0, tier: 'Bronze' },
        stats: {
          total_complaints: complaintsCount || 0,
          resolved_complaints: resolvedCount || 0,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/citizen/profile - Update citizen profile
export const updateCitizenProfile = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const { full_name, phone, address, avatar_url } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const updateData = {};
    if (full_name !== undefined) updateData.full_name = full_name;
    if (phone !== undefined) updateData.phone = phone;
    if (address !== undefined) updateData.address = address;
    if (avatar_url !== undefined) updateData.avatar_url = avatar_url;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No fields to update.' });
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .update(updateData)
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      message: 'Profile updated successfully.',
      profile,
    });
  } catch (err) {
    next(err);
  }
};
