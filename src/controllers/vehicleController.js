import { supabase } from '../config/supabase.js';
import { redisClient } from '../config/redis.js';

// GET /api/vehicles - Fetch real-time live positions of all vehicles from Redis
export const getAllVehicles = async (req, res, next) => {
  try {
    // Fetch all keys matching vehicle hashes in Redis
    const keys = await redisClient.keys('vehicle:*');

    if (keys.length === 0) {
      // Fallback to Supabase if Redis cache is empty
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

    res.status(200).json({
      count: vehicles.length,
      source: 'redis_cache',
      vehicles
    });
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