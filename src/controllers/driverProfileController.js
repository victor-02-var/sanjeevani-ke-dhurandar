import { supabaseAdmin as supabase } from '../config/supabase.js';
import { cloudinary } from '../config/cloudinary.js';

// POST /api/driver/profile - Create driver profile
export const createDriverProfile = async (req, res, next) => {
  try {
    const driverId = req.user.id;
    const { full_name, mobile_number, address, driving_experience, vehicle_type } = req.body;

    if (!full_name || !mobile_number || !address || !driving_experience) {
      return res.status(400).json({ error: 'full_name, mobile_number, address, and driving_experience are required.' });
    }

    const validExperience = ['none', '2-3 years', 'more than 3 years'];
    if (!validExperience.includes(driving_experience)) {
      return res.status(400).json({ error: `driving_experience must be one of: ${validExperience.join(', ')}` });
    }

    if (!req.file) return res.status(400).json({ error: 'Driving license photo is required.' });

    // Check if profile already exists
    const { data: existing } = await supabase.from('driver_profiles').select('id').eq('driver_id', driverId).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Driver profile already exists.' });

    // Upload license photo to Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'driver_licenses', resource_type: 'image' },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    const { data: profile, error } = await supabase
      .from('driver_profiles')
      .insert([{
        driver_id: driverId,
        full_name,
        mobile_number,
        address,
        driving_license_photo: uploadResult.secure_url,
        driving_experience,
        vehicle_type: vehicle_type || null,
      }])
      .select('*')
      .single();

    if (error) throw error;

    res.status(201).json({ message: 'Driver profile created successfully.', profile });
  } catch (err) {
    next(err);
  }
};

// GET /api/driver/profile - Get driver profile
export const getDriverProfile = async (req, res, next) => {
  try {
    const driverId = req.user.id;

    const { data: profile, error } = await supabase
      .from('driver_profiles')
      .select('*')
      .eq('driver_id', driverId)
      .single();

    if (error || !profile) return res.status(404).json({ error: 'Driver profile not found.' });

    res.status(200).json({ profile });
  } catch (err) {
    next(err);
  }
};
