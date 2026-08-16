import { supabase } from './src/config/supabase.js';
import { redisClient } from './src/config/redis.js';
import { generateMockVehicles } from './src/utils/mockVehicleGenerator.js';

async function seedVehicles() {
  console.log('⌛ Seeding 8 garbage trucks...');
  const mockVehicles = generateMockVehicles();

  // Clear existing vehicles
  await supabase.from('vehicles').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  // Insert into Supabase
  const { data: vehicles, error } = await supabase
    .from('vehicles')
    .insert(mockVehicles)
    .select();

  if (error) {
    console.error('❌ Error seeding vehicles to Supabase:', error.message);
    process.exit(1);
  }

  console.log('⌛ Syncing vehicles into Redis Geospatial Store...');

  for (const v of vehicles) {
    // 1. Add coordinates to Redis GEO spatial set
    await redisClient.geoAdd('vehicles:locations', {
      longitude: v.longitude,
      latitude: v.latitude,
      member: v.id
    });

    // 2. Cache full vehicle telemetry hash in Redis
    await redisClient.hSet(`vehicle:${v.id}`, {
      id: v.id,
      driver_name: v.driver_name,
      latitude: v.latitude.toString(),
      longitude: v.longitude.toString(),
      speed: v.speed.toString(),
      status: v.status,
      updated_at: new Date().toISOString()
    });
  }

  console.log('✅ Successfully seeded vehicles to Supabase and Redis!');
  process.exit(0);
}

seedVehicles();