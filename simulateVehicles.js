import { redisClient } from './src/config/redis.js';
import { supabase } from './src/config/supabase.js';

async function startGpsSimulation() {
  console.log('🚀 GPS Vehicle Simulation Engine Started!');
  console.log('🛰️ Updating truck coordinates in Redis every 3 seconds...\n');

  setInterval(async () => {
    try {
      const keys = await redisClient.keys('vehicle:*');

      for (const key of keys) {
        const vehicle = await redisClient.hGetAll(key);

        if (vehicle && vehicle.status === 'Collecting') {
          // Calculate slight latitude and longitude step changes (simulate driving)
          const deltaLat = (Math.random() - 0.48) * 0.0008;
          const deltaLng = (Math.random() - 0.48) * 0.0008;

          const newLat = parseFloat((parseFloat(vehicle.latitude) + deltaLat).toFixed(6));
          const newLng = parseFloat((parseFloat(vehicle.longitude) + deltaLng).toFixed(6));
          const newSpeed = Math.floor(Math.random() * 25) + 15; // Speed between 15 - 40 km/h
          const now = new Date().toISOString();

          // 1. Update Redis Geospatial set
          await redisClient.geoAdd('vehicles:locations', {
            longitude: newLng,
            latitude: newLat,
            member: vehicle.id
          });

          // 2. Update Redis vehicle hash
          await redisClient.hSet(key, {
            latitude: newLat.toString(),
            longitude: newLng.toString(),
            speed: newSpeed.toString(),
            updated_at: now
          });

          // 3. Periodically sync back to Supabase DB
          await supabase
            .from('vehicles')
            .update({
              latitude: newLat,
              longitude: newLng,
              speed: newSpeed,
              updated_at: now
            })
            .eq('id', vehicle.id);

          console.log(`🚛 [Vehicle ${vehicle.id.slice(0, 8)}] Location Updated -> Lat: ${newLat}, Lng: ${newLng}, Speed: ${newSpeed} km/h`);
        }
      }
    } catch (err) {
      console.error('❌ Error during simulation tick:', err.message);
    }
  }, 3000); // Trigger every 3000ms (3 seconds)
}

startGpsSimulation();