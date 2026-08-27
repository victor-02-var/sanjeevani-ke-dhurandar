import { supabase, supabaseAdmin } from '../config/supabase.js';

// POST /api/auth/vehicle-authority/login
export const vehicleAuthorityLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    console.log('🔐 Vehicle Authority Login Attempt:', { email: email?.trim().toLowerCase(), timestamp: new Date().toISOString() });

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // 1. Sign in via Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (authError || !authData?.user) {
      console.error('❌ Vehicle Authority Login Error:', {
        email: email.trim().toLowerCase(),
        error: authError?.message || 'Unknown error',
        code: authError?.code,
        status: authError?.status
      });
      
      // Provide more specific error messages
      if (authError?.message?.includes('Email not confirmed')) {
        return res.status(401).json({ 
          error: 'Email not verified. Please contact admin to verify your account.',
          code: 'EMAIL_NOT_CONFIRMED'
        });
      }
      
      if (authError?.message?.includes('Invalid login credentials')) {
        return res.status(401).json({ 
          error: 'Invalid email or password.',
          code: 'INVALID_CREDENTIALS'
        });
      }
      
      return res.status(401).json({ 
        error: authError?.message || 'Login failed. Please check your credentials.',
        code: 'LOGIN_FAILED'
      });
    }

    console.log('✅ Supabase Auth Success for:', authData.user.email);

    console.log('✅ Supabase Auth Success for:', authData.user.email);

    // 2. Fetch profile and confirm role is vehicle_authority
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, role, avatar_url, is_active')
      .eq('id', authData.user.id)
      .maybeSingle();

    if (profileError || !profile) {
      console.error('❌ Profile Not Found:', { userId: authData.user.id, error: profileError });
      return res.status(401).json({ error: 'Vehicle authority profile not found.' });
    }

    console.log('📋 Profile Retrieved:', { 
      id: profile.id, 
      email: profile.email, 
      role: profile.role, 
      is_active: profile.is_active 
    });

    if (profile.role !== 'vehicle_authority') {
      console.error('❌ Role Mismatch:', { expected: 'vehicle_authority', actual: profile.role });
      return res.status(403).json({ error: 'Access forbidden. Vehicle authority account required.' });
    }

    if (!profile.is_active) {
      console.error('❌ Account Inactive:', { email: profile.email });
      return res.status(403).json({ error: 'Your account has been deactivated. Contact admin.' });
    }

    // 3. Fetch managed vehicles count and stats
    const { data: vehicles, count } = await supabaseAdmin
      .from('vehicles')
      .select('id, license_plate, status, driver_name', { count: 'exact' })
      .eq('authority_id', profile.id);

    console.log('✅ Login Successful:', { 
      email: profile.email, 
      vehicleCount: count || 0,
      timestamp: new Date().toISOString()
    });

    res.status(200).json({
      message: 'Vehicle authority login successful.',
      user: {
        id: profile.id,
        email: profile.email,
        full_name: profile.full_name,
        role: profile.role,
        avatar_url: profile.avatar_url,
      },
      managed_vehicles: {
        count: count || 0,
        vehicles: vehicles || [],
      },
      access_token: authData.session.access_token,
      refresh_token: authData.session.refresh_token,
      expires_at: authData.session.expires_at,
    });
  } catch (err) {
    console.error('❌ Vehicle Authority Login Exception:', err);
    next(err);
  }
};

// GET /api/auth/vehicle-authority/profile
export const getVehicleAuthorityProfile = async (req, res, next) => {
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
      return res.status(404).json({ error: 'Profile not found.' });
    }

    if (profile.role !== 'vehicle_authority') {
      return res.status(403).json({ error: 'Not a vehicle authority account.' });
    }

    res.status(200).json({ profile });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/auth/vehicle-authority/profile
export const updateVehicleAuthorityProfile = async (req, res, next) => {
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
