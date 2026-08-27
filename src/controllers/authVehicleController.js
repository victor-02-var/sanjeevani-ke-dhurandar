import { supabaseAdmin } from '../config/supabase.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';

// POST /api/auth/vehicle/login
export const vehicleLogin = async (req, res, next) => {
  try {
    const { username, password } = req.body;

    console.log('🚗 Vehicle Login Attempt:', { username, timestamp: new Date().toISOString() });

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    // Find vehicle by username OR by authority email
    const normalizedUsername = username.trim().toUpperCase();
    const isEmail = username.includes('@');

    let vehicle = null;
    let vehicleError = null;

    if (isEmail) {
      // Look up the profile by email to get the authority id, then find the vehicle
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .ilike('email', username.trim())
        .maybeSingle();

      if (profile) {
        const { data: v, error: e } = await supabaseAdmin
          .from('vehicles')
          .select('*')
          .eq('driver_id', profile.id)
          .maybeSingle();
        vehicle = v;
        vehicleError = e;

        // If found via email, verify password against Supabase Auth
        if (vehicle) {
          const { error: signInError } = await supabaseAdmin.auth.signInWithPassword({
            email: username.trim().toLowerCase(),
            password,
          });
          if (signInError) {
            console.error('❌ Email/password auth failed:', signInError.message);
            return res.status(401).json({ error: 'Invalid username or password.' });
          }
          // Skip bcrypt check below — auth already verified
          if (vehicle.is_portal_active === false) {
            return res.status(403).json({ error: 'Vehicle portal access is disabled. Contact admin.' });
          }
          console.log('✅ Vehicle login successful via email:', vehicle.license_plate);
          supabaseAdmin.from('vehicles').update({ last_login_at: new Date().toISOString() }).eq('id', vehicle.id).then(() => {}).catch(() => {});
          const token = jwt.sign(
            { vehicle_id: vehicle.id, username: vehicle.vehicle_username, license_plate: vehicle.license_plate, type: 'vehicle' },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '24h' }
          );
          return res.status(200).json({
            message: 'Vehicle login successful.',
            vehicle: {
              id: vehicle.id,
              license_plate: vehicle.license_plate,
              username: vehicle.vehicle_username,
              territory_name: vehicle.territory_name,
              status: vehicle.status,
              qr_code: vehicle.vehicle_qr_code,
              driver_name: vehicle.driver_name
            },
            access_token: token,
            expires_in: 86400
          });
        }
      }
    } else {
      const { data: v, error: e } = await supabaseAdmin
        .from('vehicles')
        .select('*')
        .ilike('vehicle_username', normalizedUsername)
        .maybeSingle();
      vehicle = v;
      vehicleError = e;
    }

    if (vehicleError) {
      console.error('❌ Vehicle lookup error:', vehicleError);
      return res.status(500).json({ error: 'Login verification failed.' });
    }

    if (!vehicle) {
      console.error('❌ Vehicle not found for username:', normalizedUsername);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    console.log('✅ Vehicle found:', {
      id: vehicle.id,
      license_plate: vehicle.license_plate,
      vehicle_username: vehicle.vehicle_username,
      has_password_hash: !!vehicle.vehicle_password_hash,
      has_password: !!vehicle.vehicle_password,
      hash_prefix: vehicle.vehicle_password_hash?.substring(0, 7) || 'NONE',
      is_portal_active: vehicle.is_portal_active,
    });

    // Check if vehicle has password data
    const storedHash = vehicle.vehicle_password_hash;
    if (!storedHash) {
      console.error('❌ Vehicle has no password configuration:', vehicle.id);
      return res.status(403).json({ error: 'Vehicle authentication not configured. Contact admin.' });
    }

    // Verify password against bcrypt or legacy options
    let passwordMatch = false;
    let isLegacyHash = false;
    try {
      if (storedHash.startsWith('$2b$') || storedHash.startsWith('$2a$')) {
        passwordMatch = await bcrypt.compare(password, storedHash);
        console.log('🔑 Node bcrypt compare result:', passwordMatch);
      } else if (storedHash.startsWith('$2y$')) {
        const compatibleHash = storedHash.replace(/^\$2y\$/, '$2b$');
        passwordMatch = await bcrypt.compare(password, compatibleHash);
        console.log('🔑 pgcrypto bcrypt compare result:', passwordMatch);
      } else {
        passwordMatch = (storedHash === password);
        console.log('🔑 Plain text compare result:', passwordMatch, '| hash length:', storedHash.length);
      }
    } catch (e) {
      console.error('🔑 bcrypt compare threw error:', e.message);
      passwordMatch = (storedHash === password);
    }

    const legacyPasswordHash = createHash('sha256')
      .update(`${password}salt`)
      .digest('hex');
    isLegacyHash = storedHash === legacyPasswordHash;
    console.log('🔑 SHA-256 legacy match:', isLegacyHash);
    passwordMatch = passwordMatch || isLegacyHash;

    if (!passwordMatch) {
      console.error('❌ Password mismatch for vehicle:', username);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // Upgrade legacy/pgcrypto credentials to Node bcrypt automatically on successful login
    const isNodeBcrypt = storedHash.startsWith('$2b$') || storedHash.startsWith('$2a$');
    if (!isNodeBcrypt || isLegacyHash) {
      const bcryptHash = await bcrypt.hash(password, 12);
      await supabaseAdmin
        .from('vehicles')
        .update({ vehicle_password_hash: bcryptHash })
        .eq('id', vehicle.id);
    }

    // Check if portal access is enabled (default to true if column is missing/null)
    if (vehicle.is_portal_active === false) {
      console.error('❌ Portal access disabled for vehicle:', vehicle.id);
      return res.status(403).json({ error: 'Vehicle portal access is disabled. Contact admin.' });
    }

    console.log('✅ Vehicle login successful:', vehicle.license_plate);

    // Update last login timestamp safely
    supabaseAdmin
      .from('vehicles')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', vehicle.id)
      .then(() => {}).catch(() => {}); // Non-blocking

    // Generate JWT token for vehicle session
    const token = jwt.sign(
      {
        vehicle_id: vehicle.id,
        username: vehicle.vehicle_username,
        license_plate: vehicle.license_plate,
        type: 'vehicle'
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );

    res.status(200).json({
      message: 'Vehicle login successful.',
      vehicle: {
        id: vehicle.id,
        license_plate: vehicle.license_plate,
        username: vehicle.vehicle_username,
        territory_name: vehicle.territory_name,
        status: vehicle.status,
        qr_code: vehicle.vehicle_qr_code,
        driver_name: vehicle.driver_name
      },
      access_token: token,
      expires_in: 86400 // 24 hours in seconds
    });
  } catch (err) {
    console.error('❌ Vehicle login exception:', err);
    next(err);
  }
};

// GET /api/auth/vehicle/dashboard
export const getVehicleDashboard = async (req, res, next) => {
  try {
    const vehicleId = req.vehicle?.id;

    if (!vehicleId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Try fetching from dashboard stats view, with a safe fallback to direct vehicle table metrics
    const { data: stats, error: statsError } = await supabaseAdmin
      .from('vehicle_dashboard_stats')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .maybeSingle();

    if (statsError || !stats) {
      // Fallback query directly from vehicles table if view is missing
      const { data: vehicleData } = await supabaseAdmin
        .from('vehicles')
        .select('*')
        .eq('id', vehicleId)
        .single();

      return res.status(200).json({
        dashboard: vehicleData || { vehicle_id: vehicleId }
      });
    }

    res.status(200).json({
      dashboard: stats
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/auth/vehicle/profile
export const getVehicleProfile = async (req, res, next) => {
  try {
    const vehicleId = req.vehicle?.id;

    if (!vehicleId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data: vehicle, error } = await supabaseAdmin
      .from('vehicles')
      .select('*')
      .eq('id', vehicleId)
      .single();

    if (error || !vehicle) {
      return res.status(404).json({ error: 'Vehicle not found.' });
    }

    res.status(200).json({
      vehicle
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/auth/vehicle/scan-logs
export const getVehicleScanLogs = async (req, res, next) => {
  try {
    const vehicleId = req.vehicle?.id;
    const { page = 1, limit = 20, verified, days = 30 } = req.query;

    if (!vehicleId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('vehicle_scan_logs')
      .select('*', { count: 'exact' })
      .eq('vehicle_id', vehicleId)
      .order('scan_timestamp', { ascending: false })
      .range(offset, offset + limit - 1);

    if (verified !== undefined) {
      query = query.eq('verified_by_admin', verified === 'true');
    }

    if (days) {
      const dateThreshold = new Date();
      dateThreshold.setDate(dateThreshold.getDate() - parseInt(days));
      query = query.gte('scan_timestamp', dateThreshold.toISOString());
    }

    const { data: logs, error, count } = await query;

    if (error) {
      console.error('Scan logs error:', error);
      return res.status(500).json({ error: 'Failed to fetch scan logs.' });
    }

    res.status(200).json({
      logs: logs || [],
      pagination: {
        total: count || 0,
        page: parseInt(page),
        limit: parseInt(limit),
        total_pages: count ? Math.ceil(count / limit) : 1
      }
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/auth/vehicle/qr-code
export const getVehicleQRCode = async (req, res, next) => {
  try {
    const vehicleId = req.vehicle?.id;

    if (!vehicleId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let { data: vehicle, error } = await supabaseAdmin
      .from('vehicles')
      .select('vehicle_qr_code, license_plate, qr_generated_at')
      .eq('id', vehicleId)
      .single();

    if (error || !vehicle) {
      return res.status(404).json({ error: 'Vehicle not found.' });
    }

    // Auto-generate QR code if missing
    if (!vehicle.vehicle_qr_code) {
      const newQrCode = `QR-${vehicleId}-${Math.random().toString(36).slice(2, 14)}`;
      const { data: updated } = await supabaseAdmin
        .from('vehicles')
        .update({ vehicle_qr_code: newQrCode, qr_generated_at: new Date().toISOString() })
        .eq('id', vehicleId)
        .select('vehicle_qr_code, license_plate, qr_generated_at')
        .single();
      vehicle = updated;
    }

    res.status(200).json({
      qr_code: vehicle.vehicle_qr_code,
      license_plate: vehicle.license_plate,
      generated_at: vehicle.qr_generated_at,
      vehicle_id: vehicleId,
      scan_url: `${process.env.CITIZEN_APP_URL || 'http://localhost:5173'}/citizen/scan?vehicle=${vehicle.vehicle_qr_code}`
    });
  } catch (err) {
    next(err);
  }
};

// Middleware to verify vehicle JWT token
export const authenticateVehicle = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided.' });
    }

    const token = authHeader.substring(7);
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    } catch (err) {
      if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired.' });
      return res.status(401).json({ error: 'Invalid token.' });
    }

    if (decoded.type !== 'vehicle') {
      return res.status(403).json({ error: 'Invalid token type.' });
    }

    const { data: vehicle, error } = await supabaseAdmin
      .from('vehicles')
      .select('*')
      .eq('id', decoded.vehicle_id)
      .single();

    if (error || !vehicle) {
      console.error('❌ authenticateVehicle: vehicle not found for id:', decoded.vehicle_id, error);
      return res.status(403).json({ error: 'Vehicle access denied.' });
    }

    req.vehicle = vehicle;
    next();
  } catch (err) {
    next(err);
  }
};