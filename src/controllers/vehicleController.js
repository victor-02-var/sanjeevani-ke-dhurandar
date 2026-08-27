import { supabaseAdmin as supabase } from '../config/supabase.js';
import { supabaseAdmin } from '../config/supabase.js';
import { redisClient } from '../config/redis.js';
import bcrypt from 'bcrypt';

// GET /api/vehicles - Fetch real-time live positions of all vehicles from Redis
export const getAllVehicles = async (req, res, next) => {
  try {
    const keys = await redisClient.keys('vehicle:*');

    if (keys.length === 0) {
      const { data: dbVehicles, error } = await supabase.from('vehicles').select('*');
      if (error) throw error;
      return res.status(200).json({ count: dbVehicles.length, source: 'database', vehicles: dbVehicles });
    }

    const vehicles = [];
    for (const key of keys) {
      const vehicleData = await redisClient.hGetAll(key);
      if (vehicleData && vehicleData.id) {
        vehicles.push({
          ...vehicleData,
          latitude: parseFloat(vehicleData.latitude),
          longitude: parseFloat(vehicleData.longitude),
          speed: parseFloat(vehicleData.speed)
        });
      }
    }

    res.status(200).json({ count: vehicles.length, source: 'redis_cache', vehicles });
  } catch (err) {
    next(err);
  }
};

// GET /api/vehicles/:id - Fetch single vehicle live metrics
export const getVehicleById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const vehicleData = await redisClient.hGetAll(`vehicle:${id}`);

    if (!vehicleData || !vehicleData.id) {
      const { data: dbVehicle, error } = await supabase.from('vehicles').select('*').eq('id', id).single();
      if (error || !dbVehicle) return res.status(404).json({ error: 'Vehicle not found' });
      return res.status(200).json({ vehicle: dbVehicle });
    }

    res.status(200).json({
      vehicle: {
        ...vehicleData,
        latitude: parseFloat(vehicleData.latitude),
        longitude: parseFloat(vehicleData.longitude),
        speed: parseFloat(vehicleData.speed)
      }
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/vehicles - Admin creates a new vehicle + assigns to vehicle authority
export const createVehicle = async (req, res, next) => {
  try {
    const {
      license_plate,
      vehicle_authority_name,
      vehicle_authority_phone,
      vehicle_authority_email,
      vehicle_authority_password,
      authority_id,
      capacity_kg,
      territory_name,
      min_lat, max_lat,
      min_lng, max_lng,
    } = req.body;

    if (!license_plate || !vehicle_authority_name || !vehicle_authority_email || !vehicle_authority_password) {
      return res.status(400).json({
        error: 'license_plate, vehicle_authority_name, vehicle_authority_email and vehicle_authority_password are required.'
      });
    }

    // 1. Check license plate is unique
    const { data: existing } = await supabase
      .from('vehicles')
      .select('id')
      .eq('license_plate', license_plate.trim().toUpperCase())
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ error: 'A vehicle with this license plate already exists.' });
    }

    // 2. Create vehicle authority account in Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: vehicle_authority_email.trim().toLowerCase(),
      password: vehicle_authority_password,
      email_confirm: true,
      user_metadata: { full_name: vehicle_authority_name, role: 'vehicle_authority' },
    });

    if (authError) {
      if (authError.message.includes('already registered')) {
        return res.status(400).json({ error: 'A vehicle authority account with this email already exists.' });
      }
      throw authError;
    }

    const vehicleAuthorityId = authData.user.id;

    // 3. Ensure profile row has role = vehicle_authority
    await supabaseAdmin
      .from('profiles')
      .update({ full_name: vehicle_authority_name, role: 'vehicle_authority' })
      .eq('id', vehicleAuthorityId);

    // 4. Insert vehicle row linked to vehicle authority
    const { data: vehicle, error: vehicleError } = await supabase
      .from('vehicles')
      .insert([{
        driver_id:      vehicleAuthorityId,  // This is actually the vehicle_authority_id
        authority_id:   authority_id || vehicleAuthorityId,  // Self-reference or parent authority
        driver_name:    vehicle_authority_name.trim(),
        driver_phone:   vehicle_authority_phone || null,
        license_plate:  license_plate.trim().toUpperCase(),
        capacity_kg:    capacity_kg   ? parseFloat(capacity_kg)  : 5000,
        status:         'Active',
        territory_name: territory_name || null,
        min_lat:        min_lat ? parseFloat(min_lat) : null,
        max_lat:        max_lat ? parseFloat(max_lat) : null,
        min_lng:        min_lng ? parseFloat(min_lng) : null,
        max_lng:        max_lng ? parseFloat(max_lng) : null,
      }])
      .select()
      .single();

    if (vehicleError) throw vehicleError;

    // 5. Generate vehicle portal credentials and QR code using Node bcrypt
    const portalUsername = `VEH-${license_plate.trim().toUpperCase().replace(/\s+/g, '')}`;
    const portalPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10).toUpperCase();
    const portalPasswordHash = await bcrypt.hash(portalPassword, 12);
    const portalQrCode = `QR-${vehicle.id}-${Math.random().toString(36).slice(2, 14)}`;

    await supabaseAdmin
      .from('vehicles')
      .update({
        vehicle_username: portalUsername,
        vehicle_password_hash: portalPasswordHash,
        vehicle_qr_code: portalQrCode,
        qr_generated_at: new Date().toISOString(),
        is_portal_active: true,
      })
      .eq('id', vehicle.id);

    res.status(201).json({
      message: 'Vehicle and vehicle authority account created successfully.',
      vehicle,
      vehicle_authority: {
        id: vehicleAuthorityId,
        email: vehicle_authority_email,
        full_name: vehicle_authority_name,
      },
      vehicle_portal: {
        username: portalUsername,
        password: portalPassword,
        qr_code: portalQrCode,
        login_url: '/vehicle/login',
        note: '⚠️ IMPORTANT: Save these credentials securely. The password will not be shown again!'
      }
    });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/vehicles/:id - Admin removes a vehicle
export const deleteVehicle = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { error } = await supabase.from('vehicles').delete().eq('id', id);
    if (error) throw error;

    // Also remove from Redis if cached
    await redisClient.del(`vehicle:${id}`).catch(() => {});

    res.status(200).json({ message: `Vehicle ${id} deleted successfully.` });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/vehicles/:id - Admin updates vehicle status or details
export const updateVehicle = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // Only allow certain fields to be updated
    const allowedFields = ['status', 'driver_name', 'driver_phone', 'capacity_kg', 'territory_name', 'min_lat', 'max_lat', 'min_lng', 'max_lng', 'authority_id'];
    const filteredData = {};
    
    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        filteredData[field] = updateData[field];
      }
    }

    if (Object.keys(filteredData).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    // If authority_id is being updated, verify it exists and is a vehicle_authority
    if (filteredData.authority_id) {
      const { data: authority, error: authError } = await supabaseAdmin
        .from('profiles')
        .select('id, role, full_name')
        .eq('id', filteredData.authority_id)
        .eq('role', 'vehicle_authority')
        .maybeSingle();

      if (authError || !authority) {
        return res.status(400).json({ error: 'Invalid vehicle authority ID provided.' });
      }
    }

    const { data: vehicle, error } = await supabase
      .from('vehicles')
      .update(filteredData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Vehicle not found.' });
      }
      throw error;
    }

    res.status(200).json({
      message: 'Vehicle updated successfully.',
      vehicle
    });
  } catch (err) {
    next(err);
  }
};