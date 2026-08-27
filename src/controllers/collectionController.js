import { supabaseAdmin as supabase } from '../config/supabase.js';
import { cloudinary } from '../config/cloudinary.js';
import { calculateBinMetrics } from '../utils/priorityEngine.js';

// POST /api/collections - Record a bin collection and reset its fill level (ADMIN ONLY)
export const verifyAndLogCollection = async (req, res, next) => {
  try {
    const { binId, vehicleId } = req.body;

    if (!binId) {
      return res.status(400).json({ error: 'binId is required.' });
    }

    // 1. Fetch current bin details to record pre-collection state
    const { data: bin, error: binFetchError } = await supabase
      .from('bins')
      .select('*')
      .eq('id', binId)
      .single();

    if (binFetchError || !bin) {
      return res.status(404).json({ error: 'Bin not found.' });
    }

    const beforeLevel = bin.fill_level;
    const afterLevel = 0; // Reset fill level to 0% after collection
    let verification_photo_url = null;

    // 2. Upload verification photo to Cloudinary if attached
    if (req.file) {
      const uploadPromise = new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'collection_verifications' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result.secure_url);
          }
        );
        stream.end(req.file.buffer);
      });

      verification_photo_url = await uploadPromise;
    }

    // 3. Log event into 'collections' table
    const { data: collectionLog, error: logError } = await supabase
      .from('collections')
      .insert([
        {
          bin_id: binId,
          vehicle_id: vehicleId || null,
          before_level: beforeLevel,
          after_level: afterLevel,
          verification_photo_url,
          timestamp: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (logError) throw logError;

    // 4. Calculate fresh status and priority score for 0% fill level
    const now = new Date().toISOString();
    const { status, priorityScore } = calculateBinMetrics(afterLevel, now);

    // 5. Update bin in 'bins' table
    const { data: updatedBin, error: binUpdateError } = await supabase
      .from('bins')
      .update({
        fill_level: afterLevel,
        status,
        priority_score: priorityScore,
        last_collected: now
      })
      .eq('id', binId)
      .select()
      .single();

    if (binUpdateError) throw binUpdateError;

    res.status(200).json({
      message: 'Bin collection verified and logged successfully.',
      collection: collectionLog,
      updatedBin
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/collections - Get history of all collection logs (ADMIN ONLY)
export const getCollectionLogs = async (req, res, next) => {
  try {
    const { data: logs, error } = await supabase
      .from('collections')
      .select(`
        id,
        timestamp,
        before_level,
        after_level,
        verification_photo_url,
        bins (
          id,
          latitude,
          longitude
        ),
        vehicles (
          id,
          driver_name
        )
      `)
      .order('timestamp', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      count: logs.length,
      logs
    });
  } catch (err) {
    next(err);
  }
};