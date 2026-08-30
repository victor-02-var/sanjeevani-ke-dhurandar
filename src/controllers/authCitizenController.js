import { supabase, supabaseAdmin } from '../config/supabase.js';

// POST /api/auth/citizen/signup
export const citizenSignup = async (req, res, next) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'Email, password, and full name are required.' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // Validate password length
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    console.log('📝 Attempting to create citizen account:', { email: normalizedEmail, full_name });

    // Check if user already exists
    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('email')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existingProfile) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Create user using admin client (bypasses email confirmation and rate limits)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true, // Auto-confirm email (skip verification)
      user_metadata: { full_name, role: 'citizen' },
    });

    if (authError) {
      console.error('❌ Supabase signup error:', authError);
      
      if (authError.message.includes('already registered') || authError.message.includes('already been registered')) {
        return res.status(400).json({ error: 'An account with this email already exists.' });
      }
      
      // Return the actual Supabase error message
      return res.status(400).json({ error: authError.message || 'Signup failed. Please try again.' });
    }

    console.log('✅ User created successfully:', authData.user.id);

    // Ensure profile row exists and has the correct role, even if the DB trigger did not fire.
    const { data: healedProfile, error: profileUpsertError } = await supabaseAdmin
      .from('profiles')
      .upsert({
        id: authData.user.id,
        email: normalizedEmail,
        full_name,
        role: 'citizen',
        is_active: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' })
      .select('id, email, full_name, role, avatar_url, is_active')
      .single();

    if (profileUpsertError) {
      console.error('⚠️ Failed to ensure citizen profile row:', profileUpsertError);
    }

    res.status(201).json({
      message: 'Registered successfully. You can now log in with your credentials.',
      user: { id: authData.user.id, email: authData.user.email, full_name },
    });
  } catch (err) {
    console.error('❌ Signup error:', err);
    next(err);
  }
};

// POST /api/auth/citizen/login
export const citizenLogin = async (req, res, next) => {
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

    // 2. Fetch profile and confirm role. If the profile row is missing or stale, repair it.
    let { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, role, avatar_url, is_active')
      .eq('id', authData.user.id)
      .maybeSingle();

    if (!profile || profile.role !== 'citizen') {
      const repairedName = authData.user.user_metadata?.full_name || profile?.full_name || email.trim().split('@')[0] || 'Citizen User';

      const { data: healedProfile, error: healError } = await supabaseAdmin
        .from('profiles')
        .upsert({
          id: authData.user.id,
          email: authData.user.email || email.trim().toLowerCase(),
          full_name: repairedName,
          role: 'citizen',
          is_active: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' })
        .select('id, email, full_name, role, avatar_url, is_active')
        .single();

      if (!healError && healedProfile) {
        profile = healedProfile;
      }
    }

    if (profileError && profileError.code !== 'PGRST116') {
      console.error('⚠️ Profile lookup error during citizen login:', profileError);
    }

    if (!profile) {
      return res.status(401).json({ error: 'Citizen profile not found.' });
    }

    if (profile.role !== 'citizen') {
      return res.status(403).json({ error: 'Access forbidden. Citizen account required.' });
    }

    if (!profile.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated.' });
    }

    res.status(200).json({
      message: 'Login successful',
      user: {
        id: profile.id,
        email: profile.email,
        full_name: profile.full_name,
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

// POST /api/auth/citizen/google
// Frontend calls supabase.auth.signInWithOAuth on client side,
// then sends the resulting access_token here to get the profile back
export const citizenGoogleAuth = async (req, res, next) => {
  try {
    const { access_token } = req.body;

    if (!access_token) {
      return res.status(400).json({ error: 'access_token is required.' });
    }

    // 1. Verify token and get user
    const { data: userData, error: userError } = await supabase.auth.getUser(access_token);

    if (userError || !userData?.user) {
      return res.status(401).json({ error: 'Invalid or expired Google token.' });
    }

    const authUser = userData.user;

    // 2. Get profile (auto-created by trigger on signup)
    let { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, role, avatar_url, is_active')
      .eq('id', authUser.id)
      .maybeSingle();

    // Fallback: create profile if trigger missed it
    if (!profile) {
      const { data: newProfile, error: insertError } = await supabaseAdmin
        .from('profiles')
        .insert([{
          id: authUser.id,
          email: authUser.email,
          full_name: authUser.user_metadata?.full_name || authUser.email,
          avatar_url: authUser.user_metadata?.avatar_url || null,
          role: 'citizen',
        }])
        .select()
        .single();

      if (insertError) throw insertError;
      profile = newProfile;
    }

    if (profile.role !== 'citizen') {
      return res.status(403).json({ error: 'This account is not registered as a citizen.' });
    }

    res.status(200).json({
      message: 'Google authentication successful',
      user: {
        id: profile.id,
        email: profile.email,
        full_name: profile.full_name,
        avatar_url: profile.avatar_url,
      },
      access_token,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/citizen/refresh
export const citizenRefreshToken = async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required.' });

    const { data, error } = await supabase.auth.refreshSession({ refresh_token });
    if (error || !data?.session) {
      return res.status(401).json({ error: 'Refresh token invalid or expired. Please log in again.' });
    }

    res.status(200).json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/citizen/send-otp
export const citizenSendOtp = async (req, res, next) => {
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
