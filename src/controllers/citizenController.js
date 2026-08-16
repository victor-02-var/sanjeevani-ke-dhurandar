import { extractGpsFromMetadata, verifyGarbageImage } from '../services/imageService.js';
import { supabase } from '../config/supabase.js';

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