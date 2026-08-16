import { supabase } from '../src/config/supabase.js';
import { redisClient } from '../src/config/redis.js';
import fetch from 'node-fetch';

const BACKEND_URL = 'http://localhost:5000/api';
const SIMULATION_INTERVAL_MS = 2500; // Update every 2.5 seconds for smooth movement

// Distance helper to check bin proximity (~25 meters threshold)
function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// Ensure coordinate stays clamped strictly within territory bounds
function clampToTerritory(lat, lng, territory) {
  if (!territory || !territory.minLat) return { lat, lng };
  
  const clampedLat = Math.max(territory.minLat, Math.min(territory.maxLat, lat));
  const clampedLng = Math.max(territory.minLng, Math.min(territory.maxLng, lng));
  
  return { lat: clampedLat, lng: clampedLng };
}

async function runStrictRouteSimulation() {
  console.log('🚀 Initializing Strict Route-Bound & Territory-Geofenced Simulation...');

  if (!redisClient.isOpen) await redisClient.connect();

  // 1. Fetch active vehicles from database
  const { data: vehicles, error: vErr } = await supabase.from('vehicles').select('*');
  if (vErr || !vehicles || vehicles.length === 0) {
    console.error('❌ No vehicles found in database:', vErr);
    process.exit(1);
  }

  // 2. Fetch active bins from database
  const { data: bins, error: bErr } = await supabase.from('bins').select('*');
  if (bErr) {
    console.error('❌ Error fetching bins:', bErr);
    process.exit(1);
  }

  // 3. Format vehicle payload for optimization endpoint
  const vehiclesPayload = vehicles.map((v) => ({
    vehicleId: v.id,
    driverName: v.driver_name || `Driver ${v.id}`,
    capacity: v.capacity_kg || 5000,
    currentLoad: v.current_load_kg || 0,
    minLat: parseFloat(v.min_lat || 19.9800),
    maxLat: parseFloat(v.max_lat || 20.0200),
    minLng: parseFloat(v.min_lng || 73.7500),
    maxLng: parseFloat(v.max_lng || 73.8100),
  }));

  console.log('⌛ Requesting exact OSRM driving polylines from backend API...');

  // 4. Request route polylines from your route optimization endpoint
  const optResponse = await fetch(`${BACKEND_URL}/routes/optimize-fleet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      depotLat: 19.9975,
      depotLng: 73.7898,
      vehicles: vehiclesPayload,
      bins: bins || [],
    }),
  });

  const optData = await optResponse.json();

  if (!optData || !optData.routes || optData.routes.length === 0) {
    console.error('❌ Failed to retrieve route geometries:', optData);
    process.exit(1);
  }

  // 5. Build route trackers using the precise OSRM line geometry coordinates
  const activeSimulators = optData.routes.map((route) => {
    const geoCoords = route.geometry?.coordinates || [];
    // OSRM GeoJSON format is [longitude, latitude], convert to [latitude, longitude]
    const waypoints = geoCoords.map((c) => [c[1], c[0]]);

    const vehicleInfo = vehicles.find((v) => String(v.id) === String(route.vehicleId));

    return {
      vehicleId: String(route.vehicleId),
      driverName: route.driver?.name || `Driver ${route.vehicleId}`,
      waypoints: waypoints,
      currentIndex: 0,
      assignedBins: route.assignedBins || [],
      currentPayloadKg: route.driver?.assignedLoadKg || 0,
      maxCapacityKg: route.driver?.maxCapacityKg || 5000,
      speedKmh: 30,
      territory: {
        minLat: parseFloat(vehicleInfo?.min_lat || 19.9500),
        maxLat: parseFloat(vehicleInfo?.max_lat || 20.0500),
        minLng: parseFloat(vehicleInfo?.min_lng || 73.7000),
        maxLng: parseFloat(vehicleInfo?.max_lng || 73.8500),
      }
    };
  });

  console.log(`✅ Loaded ${activeSimulators.length} strict route simulators. Starting geofenced movement loop...\n`);

  // 6. Simulation Loop: Step vehicles strictly along their designated route waypoints
  setInterval(async () => {
    for (const sim of activeSimulators) {
      if (sim.waypoints.length === 0) continue;

      // Get exact raw waypoint coordinate from the calculated OSRM polyline path
      let [rawLat, rawLng] = sim.waypoints[sim.currentIndex];

      // Strict Enforcement: Clamp coordinates to ensure vehicle stays inside its assigned territory box
      const clamped = clampToTerritory(rawLat, rawLng, sim.territory);
      const currLat = clamped.lat;
      const currLng = clamped.lng;

      // Step A: Check collection of assigned bins along the path
      for (const bin of sim.assignedBins) {
        const binLat = parseFloat(bin.latitude || bin.lat);
        const binLng = parseFloat(bin.longitude || bin.lng);
        const distMeters = getDistanceMeters(currLat, currLng, binLat, binLng);

        // If truck passes within 25 meters of an assigned bin, collect waste
        if (distMeters <= 25 && (bin.fill_level || 0) > 0) {
          const collectedWeight = bin.current_weight_kg || Math.floor((bin.fill_level || 50) * 3.5);
          sim.currentPayloadKg = Math.min(sim.maxCapacityKg, sim.currentPayloadKg + collectedWeight);

          console.log(
            `🗑️ [COLLECTION] ${sim.driverName} emptied Bin ${bin.id}! ` +
            `Load: ${sim.currentPayloadKg}/${sim.maxCapacityKg} kg`
          );

          // Update bin state in Supabase DB
          await supabase
            .from('bins')
            .update({ fill_level: 0, status: 'Normal', current_weight_kg: 0 })
            .eq('id', bin.id);
        }
      }

      // Step B: Push strictly geofenced, route-bound GPS coordinates into Redis
      await redisClient.geoAdd('vehicles:locations', {
        longitude: currLng,
        latitude: currLat,
        member: sim.vehicleId,
      });

      await redisClient.hSet(`vehicle:${sim.vehicleId}`, {
        id: sim.vehicleId,
        driver_name: sim.driverName,
        latitude: currLat.toString(),
        longitude: currLng.toString(),
        speed: sim.speedKmh.toString(),
        payload_kg: sim.currentPayloadKg.toString(),
        capacity_kg: sim.maxCapacityKg.toString(),
        status: sim.currentPayloadKg >= sim.maxCapacityKg ? 'Full' : 'In Service',
        updated_at: new Date().toISOString(),
      });

      // Step C: Advance to next point on the exact OSRM polyline path (loops seamlessly)
      sim.currentIndex = (sim.currentIndex + 1) % sim.waypoints.length;
    }

    console.log(`📡 [GPS Stream] Vehicles following strict route geometries within boundaries...`);
  }, SIMULATION_INTERVAL_MS);
}

runStrictRouteSimulation().catch(console.error);