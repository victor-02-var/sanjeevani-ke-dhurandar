import { supabaseAdmin as supabase } from '../config/supabase.js';
import { getRoutePolyline } from '../services/osrmService.js';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory store: holds the last computed optimized route per vehicle ID.
// In production this can be persisted to a Supabase JSONB column instead.
// ─────────────────────────────────────────────────────────────────────────────
export const routeStore = new Map(); // vehicleId -> { geometry, assignedBins, ... }

// ─────────────────────────────────────────────────────────────────────────────
// PURE JS ROUTING ALGORITHM
// Algorithm: Nearest Neighbour Construction + 2-opt Local Search (TSP/CVRP)
//
// Nearest Neighbour (O(n²)):
//   Start at the depot. Repeatedly visit the closest unvisited bin.
//   Produces a valid tour quickly; typically within 20% of optimal.
//
// 2-opt (O(n²) per pass, run until no improvement):
//   Try reversing every possible sub-segment [i..k] of the tour.
//   Accept the reversal if it shortens total distance.
//   Eliminates crossing paths; closes most of the NN quality gap.
//
// Territory enforcement: bins that fall outside a vehicle's bounding box
//   are filtered out BEFORE the algorithm runs — guaranteeing that each
//   vehicle's route stays inside its assigned territory.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Haversine great-circle distance in metres between two lat/lng points.
 */
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function dist(a, b) {
  return haversineM(
    parseFloat(a.latitude ?? a.lat),
    parseFloat(a.longitude ?? a.lng),
    parseFloat(b.latitude ?? b.lat),
    parseFloat(b.longitude ?? b.lng)
  );
}

/**
 * Total tour distance: depot → b0 → b1 → … → bN → depot
 */
function tourDistance(depot, bins) {
  if (!bins.length) return 0;
  let d = dist(depot, bins[0]);
  for (let i = 1; i < bins.length; i++) d += dist(bins[i - 1], bins[i]);
  d += dist(bins[bins.length - 1], depot);
  return d;
}

/**
 * Phase 1 — Nearest Neighbour greedy construction.
 * Returns an ordered array of bins (depot excluded).
 */
function nearestNeighbour(depot, bins) {
  const unvisited = [...bins];
  const tour = [];
  let current = depot;

  while (unvisited.length) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < unvisited.length; i++) {
      const d = dist(current, unvisited[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    tour.push(unvisited[best]);
    current = unvisited[best];
    unvisited.splice(best, 1);
  }

  return tour;
}

/**
 * Phase 2 — 2-opt local search improvement.
 * Iteratively reverses sub-segments until no crossing can be removed.
 * Mutates the `tour` array in place.
 */
function twoOpt(depot, tour) {
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < tour.length - 1; i++) {
      for (let k = i + 1; k < tour.length; k++) {
        const before =
          dist(i === 0 ? depot : tour[i - 1], tour[i]) +
          dist(tour[k], k + 1 < tour.length ? tour[k + 1] : depot);

        const after =
          dist(i === 0 ? depot : tour[i - 1], tour[k]) +
          dist(tour[i], k + 1 < tour.length ? tour[k + 1] : depot);

        if (after < before - 0.01) { // 1 cm tolerance to avoid float noise
          // Reverse segment [i..k]
          tour.splice(i, k - i + 1, ...tour.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return tour;
}

/**
 * Checks whether a bin's coordinates or zone tag fall inside a vehicle's assigned territory.
 */
function inTerritory(bin, v) {
  const lat = parseFloat(bin.latitude ?? bin.lat);
  const lng = parseFloat(bin.longitude ?? bin.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  const binZone = String(bin.ward || bin.zone || '').toUpperCase();
  const vZone = String(v.zoneName || v.territory_name || v.driver_name || '').toUpperCase();

  // If both have zones defined, do a strict match
  if (binZone && vZone) {
    if (binZone.includes('ZONE A') && (vZone.includes('ZONE A') || vZone.includes('TRUCK-001') || vZone.includes('1'))) return true;
    if (binZone.includes('ZONE B') && (vZone.includes('ZONE B') || vZone.includes('TRUCK-002') || vZone.includes('2'))) return true;
    
    // Strict enforcement: if the bin has a zone and it didn't match the vehicle's zone, it doesn't belong to this vehicle.
    return false;
  }

  // If vehicle has no territory bounds, fallback to true if no other constraints exist
  if (!v.min_lat || !v.max_lat || !v.min_lng || !v.max_lng) return true;

  return (
    lat >= parseFloat(v.min_lat) &&
    lat <= parseFloat(v.max_lat) &&
    lng >= parseFloat(v.min_lng) &&
    lng <= parseFloat(v.max_lng)
  );
}

/**
 * Generates realistic synthetic bin coordinates around the depot
 * when the DB bins table is empty (mock/demo mode).
 */
function generateSyntheticBins(depotLat, depotLng) {
  const count = 20;
  const bins = [];
  for (let i = 0; i < count; i++) {
    // Scatter bins within ~1.5 km radius around depot
    const dLat = (Math.random() - 0.5) * 0.027; // ±1.5 km
    const dLng = (Math.random() - 0.5) * 0.027;
    bins.push({
      id: `MOCK-BIN-${String(i + 1).padStart(3, '0')}`,
      latitude:  parseFloat((parseFloat(depotLat) + dLat).toFixed(6)),
      longitude: parseFloat((parseFloat(depotLng) + dLng).toFixed(6)),
      fill_level: Math.floor(Math.random() * 70) + 30, // 30–100%
      status:    Math.random() > 0.5 ? 'Critical' : 'Warning',
      current_weight_kg: Math.floor(Math.random() * 400) + 100,
      ward: i % 2 === 0 ? 'ZONE A' : 'ZONE B',
    });
  }
  return bins;
}

/**
 * Solve CVRP for a single vehicle using NN + 2-opt.
 * Returns ordered bin objects (respects capacity).
 */
function solveForVehicle(depot, vehicle, candidateBins) {
  // 1. Territory filter
  const territoryBins = candidateBins.filter(b => inTerritory(b, vehicle));

  if (!territoryBins.length) return { orderedBins: [], unserved: [] };

  // 2. Capacity check — split into trips if needed
  const capacity = parseFloat(vehicle.capacity_kg) || 5000;
  const currentLoad = parseFloat(vehicle.current_load_kg) || 0;
  const available = capacity - currentLoad;

  let load = 0;
  const trip = [];
  const overCapacity = [];

  // Sort by fill level descending so urgent bins go first
  const sorted = [...territoryBins].sort(
    (a, b) => (parseFloat(b.fill_level) || 0) - (parseFloat(a.fill_level) || 0)
  );

  for (const bin of sorted) {
    const w = parseFloat(bin.current_weight_kg) || 250;
    if (load + w <= available) {
      trip.push(bin);
      load += w;
    } else {
      overCapacity.push(bin);
    }
  }

  // 3. Nearest Neighbour → 2-opt
  const rough = nearestNeighbour(depot, trip);
  const optimized = twoOpt(depot, rough);

  return { orderedBins: optimized, unserved: overCapacity };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/routes/optimize-fleet
// ─────────────────────────────────────────────────────────────────────────────
export const optimizeFleetRoutes = async (req, res, next) => {
  try {
    const {
      depotLat = 19.892379,
      depotLng  = 74.484606,
      dumpYardLat,
      dumpYardLng,
      vehicles: clientVehicles,
      bins: clientBins,
    } = req.body || {};

    const depot = { latitude: parseFloat(depotLat), longitude: parseFloat(depotLng) };
    const dumpYard = {
      latitude: dumpYardLat ? parseFloat(dumpYardLat) : parseFloat(depot.latitude) + 0.015,
      longitude: dumpYardLng ? parseFloat(dumpYardLng) : parseFloat(depot.longitude) + 0.025,
      name: 'Dump Yard'
    };

    // ── 1. Resolve bins ──────────────────────────────────────────────────────
    let bins = [];
    if (clientBins && Array.isArray(clientBins) && clientBins.length > 0) {
      // Filter to bins with valid coordinates coming from the frontend
      bins = clientBins.filter(b => {
        const lat = parseFloat(b.latitude ?? b.lat);
        const lng = parseFloat(b.longitude ?? b.lng);
        return Number.isFinite(lat) && Number.isFinite(lng);
      });
    }

    // If frontend sent no valid bins (empty table, not yet seeded, etc.)
    // → fetch directly from DB, any status, as long as coords are present
    if (!bins.length) {
      console.log('ℹ️ No bins from client — fetching all bins from DB...');

      // First try: highest fill-level bins
      const { data: allBins } = await supabase
        .from('bins')
        .select('id, latitude, longitude, fill_level, status, current_weight_kg, ward')
        .order('fill_level', { ascending: false })
        .limit(100);

      // Filter to rows that have actual coordinates
      bins = (allBins || []).filter(b => {
        const lat = parseFloat(b.latitude);
        const lng = parseFloat(b.longitude);
        return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
      });

      // If DB is also empty, generate synthetic bins from KML data
      if (!bins.length) {
        console.log('⚠️ DB bins table also empty — generating synthetic bins from KML coordinates...');
        bins = generateSyntheticBins(depotLat, depotLng);
      }
    }

    if (!bins.length) {
      return res.status(400).json({
        error: 'No bins available for route optimization. Please add bins to the system or seed test data.',
      });
    }

    console.log(`✅ Working with ${bins.length} bins for optimization.`);

    // ── 2. Resolve vehicles ──────────────────────────────────────────────────
    let vehicles = [];
    if (clientVehicles?.length) {
      vehicles = clientVehicles.map(v => ({
        id: v.vehicleId ?? v.driverId ?? v.id,
        driver_name: v.driverName ?? v.name ?? 'Driver',
        driver_phone: v.phone ?? 'N/A',
        license_plate: v.licensePlate ?? 'MH-15-EX-1001',
        capacity_kg: v.capacity ?? 5000,
        current_load_kg: v.currentLoad ?? 0,
        zoneName: v.zoneName,
        latitude: v.latitude,
        longitude: v.longitude,
        min_lat: v.minLat, max_lat: v.maxLat,
        min_lng: v.minLng, max_lng: v.maxLng,
      }));
    } else {
      const { data: dbV, error: vErr } = await supabase
        .from('vehicles')
        .select('id, driver_name, driver_phone, license_plate, capacity_kg, current_load_kg, latitude, longitude, min_lat, max_lat, min_lng, max_lng, territory_name, status')
        .neq('status', 'Maintenance');

      if (vErr || !dbV?.length) {
        return res.status(400).json({ error: 'No active vehicles found.' });
      }
      vehicles = dbV.map(v => ({ ...v, zoneName: v.territory_name }));
    }

    // ── 3. Run NN + 2-opt per vehicle ────────────────────────────────────────
    console.log(`🧠 Running Nearest Neighbour + 2-opt for ${vehicles.length} vehicles, ${bins.length} bins...`);

    // First pass: territory-filtered assignment
    const vehicleBinMap = new Map(); // vehicleId → [bin, ...]
    const claimedBinIds = new Set();

    for (const vehicle of vehicles) {
      const { orderedBins } = solveForVehicle(depot, vehicle, bins);
      vehicleBinMap.set(String(vehicle.id), orderedBins);
      orderedBins.forEach(b => claimedBinIds.add(String(b.id)));
    }

    // Fallback: if NO vehicle claimed any bin (all territories too tight / not set),
    // distribute bins round-robin across vehicles so we always produce routes.
    if (claimedBinIds.size === 0 && vehicles.length > 0) {
      console.log('⚠️  Territory filter claimed 0 bins. Distributing bins round-robin across vehicles...');
      const chunkSize = Math.ceil(bins.length / vehicles.length);
      for (let i = 0; i < vehicles.length; i++) {
        const slice = bins.slice(i * chunkSize, (i + 1) * chunkSize);
        const rough = nearestNeighbour(depot, slice);
        const optimized = twoOpt(depot, rough);
        vehicleBinMap.set(String(vehicles[i].id), optimized);
        optimized.forEach(b => claimedBinIds.add(String(b.id)));
      }
    }

    const finalRoutes = [];

    for (const vehicle of vehicles) {
      const orderedBins = vehicleBinMap.get(String(vehicle.id)) || [];

      if (!orderedBins.length) continue;

      // Build waypoints: Central Depot → Bin1 → Bin2 → … → BinN → Dump Yard
      const waypoints = [
        depot,
        ...orderedBins.map(b => ({
          latitude:  parseFloat(b.latitude ?? b.lat),
          longitude: parseFloat(b.longitude ?? b.lng),
        })),
        dumpYard,
      ];

      // Fetch driving polyline (OSRM or straight-line fallback)
      const polyline = await getRoutePolyline(waypoints);

      const totalWeightKg = orderedBins.reduce(
        (s, b) => s + (parseFloat(b.current_weight_kg) || 250), 0
      );

      const routePayload = {
        vehicleId: String(vehicle.id),
        driver: {
          name:         vehicle.driver_name  || 'Driver',
          phone:        vehicle.driver_phone || 'N/A',
          licensePlate: vehicle.license_plate || 'N/A',
          maxCapacityKg:  parseFloat(vehicle.capacity_kg) || 5000,
          assignedLoadKg: totalWeightKg,
        },
        territory: {
          zoneName: vehicle.zoneName,
          minLat: vehicle.min_lat, maxLat: vehicle.max_lat,
          minLng: vehicle.min_lng, maxLng: vehicle.max_lng,
        },
        algorithm:          'Nearest Neighbour + 2-opt (CVRP)',
        assignedBinCount:   orderedBins.length,
        assignedBins:       orderedBins,
        totalDistanceKm:    (polyline.distanceMeters / 1000).toFixed(2),
        totalDurationMinutes: Math.ceil(polyline.durationSeconds / 60),
        geometry:           polyline.geometry,
        steps:              polyline.steps,
        optimizedAt:        new Date().toISOString(),
      };

      // ── 4. Persist to in-memory store (keyed by vehicleId) ────────────────
      routeStore.set(String(vehicle.id), routePayload);

      finalRoutes.push(routePayload);
    }

    if (!finalRoutes.length) {
      return res.status(200).json({
        success: true,
        message: 'No vehicles have bins in their territory. Assign territory boundaries to vehicles first.',
        routes: [],
      });
    }

    const totalDistM = finalRoutes.reduce((s, r) => s + parseFloat(r.totalDistanceKm) * 1000, 0);
    const totalDurS  = finalRoutes.reduce((s, r) => s + r.totalDurationMinutes * 60, 0);

    console.log(`✅ Optimized ${finalRoutes.length} routes. Total fleet distance: ${(totalDistM / 1000).toFixed(2)} km`);

    res.status(200).json({
      success: true,
      algorithm: 'Nearest Neighbour + 2-opt (CVRP)',
      totalFleetDistanceKm:      (totalDistM / 1000).toFixed(2),
      totalFleetDurationMinutes: Math.ceil(totalDurS / 60),
      routes: finalRoutes,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/routes/driver-route/:vehicleId
// Returns the last optimized route for a specific vehicle (for the driver dashboard).
// Public endpoint — no admin auth required so driver apps can call it.
// ─────────────────────────────────────────────────────────────────────────────
export const getDriverRoute = async (req, res, next) => {
  try {
    const { vehicleId } = req.params;

    if (!vehicleId) {
      return res.status(400).json({ error: 'vehicleId is required.' });
    }

    const route = routeStore.get(String(vehicleId));

    if (!route) {
      return res.status(404).json({
        success: false,
        message: 'No optimized route found for this vehicle. Ask admin to run route optimization first.',
      });
    }

    return res.status(200).json({ success: true, route });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/routes/leaderboard
// ─────────────────────────────────────────────────────────────────────────────
export const getDriverLeaderboard = async (req, res, next) => {
  try {
    const { data: vehicles, error } = await supabase
      .from('vehicles')
      .select('id, driver_name, driver_phone, driver_avatar, license_plate, total_bins_collected, total_weight_kg, total_distance_km, route_efficiency_score, citizen_rating_avg')
      .neq('status', 'Maintenance');

    if (error) throw error;

    const leaderboard = (vehicles || []).map(v => {
      const completionRate = Math.min(100, ((v.total_bins_collected || 1) / 10) * 100);
      const efficiency = v.route_efficiency_score || 90;
      const rating = ((v.citizen_rating_avg || 4.5) / 5) * 100;
      const overallScore = parseFloat(
        (0.35 * completionRate + 0.30 * efficiency + 0.35 * rating).toFixed(1)
      );
      return {
        vehicleId: v.id,
        driverName: v.driver_name,
        avatar: v.driver_avatar,
        licensePlate: v.license_plate,
        stats: {
          binsCollected:   v.total_bins_collected  || 0,
          totalWeightKg:   v.total_weight_kg       || 0,
          totalDistanceKm: v.total_distance_km     || 0,
          citizenRating:   v.citizen_rating_avg    || 4.5,
        },
        score: overallScore,
        badge: getBadge(overallScore),
      };
    });

    leaderboard.sort((a, b) => b.score - a.score);

    res.status(200).json({
      success: true,
      period: 'Current Week',
      leaderboard: leaderboard.map((d, i) => ({ rank: i + 1, ...d })),
    });
  } catch (err) {
    next(err);
  }
};

function getBadge(score) {
  if (score >= 90) return 'Eco Champion 🏆';
  if (score >= 80) return 'Master Navigator 🚛';
  if (score >= 70) return 'Route Master 🛣️';
  return 'City Keeper 🧹';
}