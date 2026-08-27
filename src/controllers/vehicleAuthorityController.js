import { supabaseAdmin } from '../config/supabase.js';
import { redisClient } from '../config/redis.js';

// GET /api/vehicle-authority/vehicles - Get all vehicles managed by this authority
export const getManagedVehicles = async (req, res, next) => {
  try {
    const authorityId = req.user?.id;

    if (!authorityId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Fetch from database
    const { data: vehicles, error } = await supabaseAdmin
      .from('vehicles')
      .select('*')
      .eq('authority_id', authorityId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Try to enrich with Redis real-time data
    const enrichedVehicles = await Promise.all(
      vehicles.map(async (vehicle) => {
        try {
          const liveData = await redisClient.hGetAll(`vehicle:${vehicle.id}`);
          if (liveData && liveData.id) {
            return {
              ...vehicle,
              latitude: parseFloat(liveData.latitude || vehicle.latitude),
              longitude: parseFloat(liveData.longitude || vehicle.longitude),
              speed: parseFloat(liveData.speed || vehicle.speed),
              current_load_kg: parseFloat(liveData.current_load_kg || vehicle.current_load_kg),
              live_data: true,
            };
          }
        } catch (err) {
          // If Redis fails, just return DB data
        }
        return { ...vehicle, live_data: false };
      })
    );

    res.status(200).json({
      count: enrichedVehicles.length,
      vehicles: enrichedVehicles,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/vehicle-authority/vehicles/:id - Get specific vehicle details
export const getVehicleDetails = async (req, res, next) => {
  try {
    const authorityId = req.user?.id;
    const { id } = req.params;

    if (!authorityId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check if vehicle belongs to this authority
    const { data: vehicle, error } = await supabaseAdmin
      .from('vehicles')
      .select('*')
      .eq('id', id)
      .eq('authority_id', authorityId)
      .single();

    if (error || !vehicle) {
      return res.status(404).json({ error: 'Vehicle not found or access denied.' });
    }

    // Try to get live data from Redis
    try {
      const liveData = await redisClient.hGetAll(`vehicle:${id}`);
      if (liveData && liveData.id) {
        vehicle.latitude = parseFloat(liveData.latitude || vehicle.latitude);
        vehicle.longitude = parseFloat(liveData.longitude || vehicle.longitude);
        vehicle.speed = parseFloat(liveData.speed || vehicle.speed);
        vehicle.current_load_kg = parseFloat(liveData.current_load_kg || vehicle.current_load_kg);
        vehicle.live_data = true;
      }
    } catch (err) {
      vehicle.live_data = false;
    }

    res.status(200).json({ vehicle });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/vehicle-authority/vehicles/:id - Update vehicle details
export const updateManagedVehicle = async (req, res, next) => {
  try {
    const authorityId = req.user?.id;
    const { id } = req.params;
    const updateData = req.body;

    if (!authorityId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check if vehicle belongs to this authority
    const { data: existing } = await supabaseAdmin
      .from('vehicles')
      .select('id')
      .eq('id', id)
      .eq('authority_id', authorityId)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Vehicle not found or access denied.' });
    }

    // Only allow certain fields to be updated by vehicle authority
    const allowedFields = ['status', 'driver_name', 'driver_phone', 'capacity_kg', 'territory_name', 'min_lat', 'max_lat', 'min_lng', 'max_lng'];
    const filteredData = {};

    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        filteredData[field] = updateData[field];
      }
    }

    if (Object.keys(filteredData).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const { data: vehicle, error } = await supabaseAdmin
      .from('vehicles')
      .update(filteredData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      message: 'Vehicle updated successfully.',
      vehicle,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/vehicle-authority/dashboard-stats - Get dashboard statistics
export const getDashboardStats = async (req, res, next) => {
  try {
    const authorityId = req.user?.id;

    if (!authorityId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get vehicle counts by status
    const { data: vehicles, error: vehiclesError } = await supabaseAdmin
      .from('vehicles')
      .select('status, total_bins_collected, total_weight_kg, total_distance_km')
      .eq('authority_id', authorityId);

    if (vehiclesError) throw vehiclesError;

    const stats = {
      total_vehicles: vehicles.length,
      active_vehicles: vehicles.filter((v) => v.status === 'Active').length,
      idle_vehicles: vehicles.filter((v) => v.status === 'Idle').length,
      maintenance_vehicles: vehicles.filter((v) => v.status === 'Maintenance').length,
      offline_vehicles: vehicles.filter((v) => v.status === 'Offline').length,
      total_bins_collected: vehicles.reduce((sum, v) => sum + (v.total_bins_collected || 0), 0),
      total_weight_collected_kg: vehicles.reduce((sum, v) => sum + parseFloat(v.total_weight_kg || 0), 0),
      total_distance_km: vehicles.reduce((sum, v) => sum + parseFloat(v.total_distance_km || 0), 0),
    };

    res.status(200).json({ stats });
  } catch (err) {
    next(err);
  }
};
