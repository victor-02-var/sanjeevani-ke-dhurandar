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
  let { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, email, full_name, role, is_active')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (!profile) {
    console.warn('⚠️ Profile row missing in DB for user:', userData.user.id, '. Creating profile from Auth metadata...');
    const userRole = userData.user.user_metadata?.role || userData.user.app_metadata?.role || 'admin';
    const fullName = userData.user.user_metadata?.full_name || userData.user.email?.split('@')[0] || 'Admin User';

    const fallbackProfile = {
      id: userData.user.id,
      email: userData.user.email || 'admin@civicsync.gov.in',
      full_name: fullName,
      role: userRole,
      is_active: true,
    };

    const { data: insertedProfile } = await supabaseAdmin
      .from('profiles')
      .upsert([fallbackProfile], { onConflict: 'id' })
      .select('id, email, full_name, role, is_active')
      .maybeSingle();

    profile = insertedProfile || fallbackProfile;
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

// Accepts both Supabase user tokens AND custom vehicle/driver JWTs
// Used for endpoints that drivers call directly from the Vehicle Dashboard
export const authenticateVehicleOrUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  // Try 1: Supabase user token
  try {
    const { data: userData, error: supaErr } = await supabaseAdmin.auth.getUser(token);
    if (!supaErr && userData?.user) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('id, email, full_name, role, is_active')
        .eq('id', userData.user.id)
        .maybeSingle();

      if (profile && profile.is_active !== false) {
        req.user = profile;
        return next();
      }
    }
  } catch (_) { /* fall through */ }

  // Try 2: Custom vehicle/driver JWT
  try {
    const { default: jwt } = await import('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');

    if (decoded && decoded.vehicle_id) {
      // Vehicle JWT — look up the vehicle to attach a user-like object
      const { data: vehicle } = await supabaseAdmin
        .from('vehicles')
        .select('id, license_plate, driver_id, driver_name, territory_name, authority_id')
        .eq('id', decoded.vehicle_id)
        .maybeSingle();

      if (vehicle) {
        // Attach a synthetic user object with the vehicle's driver_id so queries work
        req.user = {
          id: vehicle.driver_id || decoded.vehicle_id,
          full_name: vehicle.driver_name || 'Driver',
          role: 'driver',
          is_active: true,
          vehicle_id: vehicle.id,
          vehicle,
        };
        return next();
      }
    }
  } catch (_) { /* fall through */ }

  return res.status(401).json({ error: 'Invalid or expired token.' });
};
