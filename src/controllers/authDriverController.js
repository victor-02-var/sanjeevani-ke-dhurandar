import { supabase, supabaseAdmin } from '../config/supabase.js';

// POST /api/auth/driver/signup
export const driverSignup = async (req, res, next) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'Email, password, and full name are required.' });
    }

    // 1. Create user in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        data: { full_name, role: 'vehicle_authority' },
      },
    });

    if (authError) {
      if (authError.message.includes('already registered')) {
        return res.status(400).json({ error: 'A vehicle authority account with this email already exists.' });
      }
      throw authError;
    }

    // 2. Ensure profile role is 'vehicle_authority'
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({ full_name, role: 'vehicle_authority' })
      .eq('id', authData.user.id);

    if (updateError) throw updateError;

    res.status(201).json({
      message: 'Vehicle authority registered successfully. Please check your email to confirm your account.',
      vehicle_authority: { id: authData.user.id, email: authData.user.email, full_name },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/driver/login
export const driverLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // 1. Sign in via Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (authError || !authData?.user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // 2. Fetch profile and confirm role is driver
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, role, avatar_url, is_active')
      .eq('id', authData.user.id)
      .maybeSingle();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'Vehicle authority profile not found.' });
    }

    if (profile.role !== 'vehicle_authority') {
      return res.status(403).json({ error: 'Access forbidden. Vehicle authority account required.' });
    }

    if (!profile.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated. Contact admin.' });
    }

    // 3. Fetch assigned vehicle if any
    const { data: vehicle } = await supabaseAdmin
      .from('vehicles')
      .select('id, license_plate, status, territory_name')
      .eq('driver_id', profile.id)
      .maybeSingle();

    res.status(200).json({
      message: 'Vehicle authority login successful.',
      vehicle_authority: {
        id: profile.id,
        email: profile.email,
        full_name: profile.full_name,
        avatar_url: profile.avatar_url,
      },
      vehicle: vehicle || null,
      access_token: authData.session.access_token,
      refresh_token: authData.session.refresh_token,
      expires_at: authData.session.expires_at,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/driver/send-otp
export const driverSendOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: false },
    });

    if (error) throw error;

    res.status(200).json({ message: 'OTP sent to email.' });
  } catch (err) {
    next(err);
  }
};


// GET /api/auth/driver/profile
export const getDriverProfile = async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, role, avatar_url, phone, address, is_active')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'Driver profile not found.' });
    }

    if (profile.role !== 'vehicle_authority') {
      return res.status(403).json({ error: 'Not a vehicle authority account.' });
    }

    // Fetch assigned vehicle
    const { data: vehicle } = await supabaseAdmin
      .from('vehicles')
      .select('id, license_plate, status, territory_name, capacity_kg, current_load_kg, total_bins_collected, total_distance_km, route_efficiency_score')
      .eq('driver_id', profile.id)
      .maybeSingle();

    res.status(200).json({
      profile,
      vehicle: vehicle || null,
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/auth/driver/profile
export const updateDriverProfile = async (req, res, next) => {
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

    const { data: profile, error } = await supabaseAdmin
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

// GET /api/auth/driver/qr-code
export const getDriverVehicleQR = async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get the vehicle assigned to this driver
    const { data: vehicle, error } = await supabaseAdmin
      .from('vehicles')
      .select('id, license_plate, vehicle_qr_code, qr_generated_at')
      .eq('driver_id', userId)
      .maybeSingle();

    if (error) {
      console.error('Error fetching vehicle QR:', error);
      return res.status(500).json({ error: 'Failed to fetch vehicle QR code.' });
    }

    if (!vehicle) {
      return res.status(404).json({ error: 'No vehicle assigned to this driver.' });
    }

    if (!vehicle.vehicle_qr_code) {
      return res.status(404).json({ 
        error: 'QR code not generated for your vehicle. Please contact admin.' 
      });
    }

    res.status(200).json({
      qr_code: vehicle.vehicle_qr_code,
      license_plate: vehicle.license_plate,
      generated_at: vehicle.qr_generated_at,
      vehicle_id: vehicle.id
    });
  } catch (err) {
    next(err);
  }
};