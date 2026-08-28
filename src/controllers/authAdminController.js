import { supabase, supabaseAdmin } from '../config/supabase.js';

// POST /api/auth/admin/login
export const adminLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // 1. Sign in via Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (authError || !authData?.user) {
      return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    // 2. Check profile role is admin
    let { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, role, avatar_url, is_active')
      .eq('id', authData.user.id)
      .maybeSingle();

    // If profile is missing or role is not admin, auto-provision admin profile for valid auth user
    if (!profile || profile.role !== 'admin') {
      const adminName = authData.user.user_metadata?.full_name || profile?.full_name || normalizedEmail.split('@')[0] || 'System Admin';

      console.log(`⚡ Auto-provisioning admin profile for ${normalizedEmail}...`);

      const { data: healedProfile, error: healError } = await supabaseAdmin
        .from('profiles')
        .upsert({
          id: authData.user.id,
          email: normalizedEmail,
          full_name: adminName,
          role: 'admin',
          is_active: true,
          updated_at: new Date().toISOString()
        })
        .select('id, email, full_name, role, avatar_url, is_active')
        .single();

      if (!healError && healedProfile) {
        profile = healedProfile;
      }
    }

    if (!profile) {
      return res.status(401).json({ error: 'Admin profile not found.' });
    }

    if (profile.role !== 'admin') {
      return res.status(403).json({ error: 'Access forbidden. Admin rights required.' });
    }

    if (!profile.is_active) {
      return res.status(403).json({ error: 'This admin account has been deactivated.' });
    }

    // 3. Return Supabase session token (access_token) — no custom JWT needed
    res.status(200).json({
      message: 'Admin authentication successful',
      user: {
        id: profile.id,
        email: profile.email,
        full_name: profile.full_name,
        role: profile.role,
        avatar_url: profile.avatar_url,
      },
      access_token: authData.session.access_token,
      refresh_token: authData.session.refresh_token,
      expires_at: authData.session.expires_at,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/admin/signup
export const adminSignup = async (req, res, next) => {
  try {
    const { full_name, email, password } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({ error: 'Full name, email, and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // 1. Create user via admin client (skips email confirmation)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name, role: 'admin' },
    });

    if (authError) {
      if (authError.message.includes('already registered')) {
        return res.status(400).json({ error: 'An account with this email already exists.' });
      }
      throw authError;
    }

    // 2. Ensure profile row has correct role (trigger may default to 'citizen')
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({ full_name, role: 'admin' })
      .eq('id', authData.user.id);

    if (updateError) throw updateError;

    res.status(201).json({
      message: 'Admin account created successfully',
      user: { id: authData.user.id, email: normalizedEmail, full_name, role: 'admin' },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/admin/create-vehicle-authority
export const createVehicleAuthority = async (req, res, next) => {
  try {
    const { full_name, email, password, phone, address } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({ error: 'Full name, email, and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // 1. Create user via admin client (skips email confirmation)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name, role: 'vehicle_authority' },
    });

    if (authError) {
      if (authError.message.includes('already registered')) {
        return res.status(400).json({ error: 'An account with this email already exists.' });
      }
      throw authError;
    }

    // 2. Update profile with vehicle_authority role and additional info
    const updateData = { 
      full_name, 
      role: 'vehicle_authority'
    };
    if (phone) updateData.phone = phone;
    if (address) updateData.address = address;

    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update(updateData)
      .eq('id', authData.user.id);

    if (updateError) throw updateError;

    res.status(201).json({
      message: 'Vehicle authority account created successfully. Credentials can be shared with the vehicle authority person.',
      user: { 
        id: authData.user.id, 
        email: normalizedEmail, 
        full_name, 
        role: 'vehicle_authority',
        phone: phone || null,
        address: address || null
      },
      credentials: {
        email: normalizedEmail,
        password: password, // Return password only on creation so admin can share it
        login_endpoint: '/api/auth/vehicle-authority/login'
      }
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/auth/admin/vehicle-authorities
export const getAllVehicleAuthorities = async (req, res, next) => {
  try {
    const { data: authorities, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, phone, address, avatar_url, is_active, created_at')
      .eq('role', 'vehicle_authority')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Get vehicle count for each authority
    const authoritiesWithStats = await Promise.all(
      authorities.map(async (authority) => {
        const { count } = await supabaseAdmin
          .from('vehicles')
          .select('id', { count: 'exact', head: true })
          .eq('authority_id', authority.id);

        return {
          ...authority,
          managed_vehicles_count: count || 0
        };
      })
    );

    res.status(200).json({
      count: authoritiesWithStats.length,
      vehicle_authorities: authoritiesWithStats
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/auth/admin/vehicle-authority/:id/toggle-status
export const toggleVehicleAuthorityStatus = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get current status
    const { data: profile, error: fetchError } = await supabaseAdmin
      .from('profiles')
      .select('is_active, role')
      .eq('id', id)
      .single();

    if (fetchError || !profile) {
      return res.status(404).json({ error: 'Vehicle authority not found.' });
    }

    if (profile.role !== 'vehicle_authority') {
      return res.status(400).json({ error: 'User is not a vehicle authority.' });
    }

    // Toggle status
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({ is_active: !profile.is_active })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.status(200).json({
      message: `Vehicle authority account ${updated.is_active ? 'activated' : 'deactivated'} successfully.`,
      user: updated
    });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/auth/admin/vehicle-authority/:id
export const deleteVehicleAuthority = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Check if user is vehicle_authority
    const { data: profile, error: fetchError } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', id)
      .single();

    if (fetchError || !profile) {
      return res.status(404).json({ error: 'Vehicle authority not found.' });
    }

    if (profile.role !== 'vehicle_authority') {
      return res.status(400).json({ error: 'User is not a vehicle authority.' });
    }

    // Delete from auth.users (cascade will handle profile)
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(id);
    
    if (authError) throw authError;

    res.status(200).json({
      message: 'Vehicle authority account deleted successfully.'
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/auth/admin/vehicle-authority/:id/confirm-email
export const confirmVehicleAuthorityEmail = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Check if user exists and is vehicle_authority
    const { data: profile, error: fetchError } = await supabaseAdmin
      .from('profiles')
      .select('email, role')
      .eq('id', id)
      .single();

    if (fetchError || !profile) {
      return res.status(404).json({ error: 'Vehicle authority not found.' });
    }

    if (profile.role !== 'vehicle_authority') {
      return res.status(400).json({ error: 'User is not a vehicle authority.' });
    }

    // Update user to confirm email
    const { data: updatedUser, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      id,
      { email_confirm: true }
    );

    if (updateError) throw updateError;

    res.status(200).json({
      message: 'Vehicle authority email confirmed successfully.',
      user: {
        id: updatedUser.user.id,
        email: updatedUser.user.email,
        email_confirmed_at: updatedUser.user.email_confirmed_at
      }
    });
  } catch (err) {
    next(err);
  }
};
