import { supabaseAdmin } from '../config/supabase.js';

// Helper: extract and verify Supabase Bearer token
const getUserFromToken = async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Access denied. No token provided.' });
    return null;
  }

  const token = authHeader.split(' ')[1];

  const { data: userData, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !userData?.user) {
    res.status(401).json({ error: 'Invalid or expired token.' });
    return null;
  }

  // Fetch profile to get role
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, email, full_name, role, is_active')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    console.error('Profile lookup failed for user:', userData.user.id, profileError?.message);
    res.status(401).json({ error: 'User profile not found.', user_id: userData.user.id });
    return null;
  }

  if (profile.is_active === false) {
    res.status(403).json({ error: 'Your account has been deactivated.' });
    return null;
  }

  return profile;
};

// Protect routes for Citizens
export const verifyCitizen = async (req, res, next) => {
  const profile = await getUserFromToken(req, res);
  if (!profile) return;

  if (profile.role !== 'citizen') {
    return res.status(403).json({ error: 'Access forbidden. Citizen rights required.' });
  }

  req.user = profile;
  next();
};

// Protect routes for Drivers
export const verifyDriver = async (req, res, next) => {
  const profile = await getUserFromToken(req, res);
  if (!profile) return;

  if (profile.role !== 'driver') {
    return res.status(403).json({ error: 'Access forbidden. Driver rights required.' });
  }

  req.user = profile;
  next();
};

// Protect routes for Admins
export const verifyAdmin = async (req, res, next) => {
  const profile = await getUserFromToken(req, res);
  if (!profile) return;

  if (profile.role !== 'admin') {
    return res.status(403).json({ error: 'Access forbidden. Admin rights required.' });
  }

  req.user = profile;
  next();
};

// Allow both Admin and Driver (e.g. collection routes)
export const verifyAdminOrDriver = async (req, res, next) => {
  const profile = await getUserFromToken(req, res);
  if (!profile) return;

  if (profile.role !== 'admin' && profile.role !== 'driver') {
    return res.status(403).json({ error: 'Access forbidden. Admin or Driver rights required.' });
  }

  req.user = profile;
  next();
};

// Protect routes for Vehicle Authority
export const verifyVehicleAuthority = async (req, res, next) => {
  const profile = await getUserFromToken(req, res);
  if (!profile) return;

  if (profile.role !== 'vehicle_authority') {
    return res.status(403).json({ error: 'Access forbidden. Vehicle authority rights required.' });
  }

  req.user = profile;
  next();
};

// Allow Admin or Vehicle Authority (e.g. vehicle management routes)
export const verifyAdminOrVehicleAuthority = async (req, res, next) => {
  const profile = await getUserFromToken(req, res);
  if (!profile) return;

  if (profile.role !== 'admin' && profile.role !== 'vehicle_authority') {
    return res.status(403).json({ error: 'Access forbidden. Admin or Vehicle Authority rights required.' });
  }

  req.user = profile;
  next();
};

// General authentication middleware (just verify token, any role)
export const authenticateToken = async (req, res, next) => {
  const profile = await getUserFromToken(req, res);
  if (!profile) return;

  req.user = profile;
  next();
};

// Optional auth — attaches user if token valid, continues anyway if not
export const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }
  const token = authHeader.split(' ')[1];
  const { data: userData } = await supabaseAdmin.auth.getUser(token);
  if (userData?.user) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, phone, role, is_active')
      .eq('id', userData.user.id)
      .maybeSingle();
    if (profile && profile.is_active !== false) {
      req.user = profile;
    }
  }
  next();
};
