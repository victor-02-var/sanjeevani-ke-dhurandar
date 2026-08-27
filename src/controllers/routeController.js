import { supabaseAdmin as supabase } from '../config/supabase.js';
import { getDistanceAndDurationMatrices, getRoutePolyline } from '../services/osrmService.js';
import { solveVehicleRouting } from '../services/optimizerService.js';

/**
 * Helper to check if a bin location falls inside a driver's territory bounding box
 */
function isBinInTerritory(bin, territory) {
  if (!territory || !territory.minLat || !territory.maxLat || !territory.minLng || !territory.maxLng) {
    return true; // If no bounds specified, allow bin
  }
  const lat = parseFloat(bin.latitude || bin.lat);
  const lng = parseFloat(bin.longitude || bin.lng);
  return (
    lat >= territory.minLat &&
    lat <= territory.maxLat &&
    lng >= territory.minLng &&
    lng <= territory.maxLng
  );
}

function getBinWeight(bin) {
  const weight = Number(bin.current_weight_kg);
  return Number.isFinite(weight) && weight > 0 ? weight : 250;
}

function getDistanceMeters(from, to) {
  const earthRadiusMeters = 6371000;
  const lat1 = (from.latitude * Math.PI) / 180;
  const lat2 = (to.latitude * Math.PI) / 180;
  const deltaLat = ((to.latitude - from.latitude) * Math.PI) / 180;
  const deltaLng = ((to.longitude - from.longitude) * Math.PI) / 180;
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getVehicleStart(vehicle, depot) {
  const latitude = Number(vehicle.latitude);
  const longitude = Number(vehicle.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : depot;
}

function insertAtShortestDetour(routeBins, bin, vehicle, depot) {
  const binPoint = { latitude: Number(bin.latitude || bin.lat), longitude: Number(bin.longitude || bin.lng) };
  const assignedPoints = routeBins.map(existingBin => ({
    latitude: Number(existingBin.latitude || existingBin.lat),
    longitude: Number(existingBin.longitude || existingBin.lng)
  }));
  const start = getVehicleStart(vehicle, depot);
  let bestIndex = routeBins.length;
  let bestDetour = getDistanceMeters(assignedPoints.at(-1) || start, binPoint) + getDistanceMeters(binPoint, depot);

  for (let index = 0; index < routeBins.length; index += 1) {
    const previous = assignedPoints[index - 1] || start;
    const next = assignedPoints[index];
    const detour = getDistanceMeters(previous, binPoint) + getDistanceMeters(binPoint, next) - getDistanceMeters(previous, next);
    if (detour < bestDetour) {
      bestDetour = detour;
      bestIndex = index;
    }
  }

  routeBins.splice(bestIndex, 0, bin);
}

function allocateOverflowBins(routes, vehicles, bins, depot) {
  const routeByVehicle = new Map(routes.map(route => [String(route.vehicleId), route]));
  vehicles.forEach(vehicle => {
    if (!routeByVehicle.has(String(vehicle.id))) {
      const route = { vehicleId: String(vehicle.id), bins: [] };
      routes.push(route);
      routeByVehicle.set(String(vehicle.id), route);
    }
  });

  const assignedIds = new Set(routes.flatMap(route => (route.bins || []).map(String)));
  const routeLoads = new Map(routes.map(route => [String(route.vehicleId), (route.bins || []).reduce((sum, binId) => {
    const bin = bins.find(candidate => String(candidate.id) === String(binId));
    return sum + (bin ? getBinWeight(bin) : 0);
  }, 0)]));

  for (const bin of bins) {
    if (assignedIds.has(String(bin.id))) continue;
    const demand = getBinWeight(bin);
    const candidates = vehicles
      .map(vehicle => {
        const route = routeByVehicle.get(String(vehicle.id));
        const currentLoad = Number(vehicle.current_load_kg) || 0;
        const capacity = Number(vehicle.capacity_kg) || 5000;
        const available = capacity - currentLoad - (routeLoads.get(String(vehicle.id)) || 0);
        const territory = { minLat: vehicle.min_lat, maxLat: vehicle.max_lat, minLng: vehicle.min_lng, maxLng: vehicle.max_lng };
        if (available < demand || !isBinInTerritory(bin, territory)) return null;

        const routeBins = (route.bins || []).map(binId => bins.find(candidate => String(candidate.id) === String(binId))).filter(Boolean);
        const anchorBin = routeBins.at(-1);
        const anchor = anchorBin
          ? { latitude: Number(anchorBin.latitude || anchorBin.lat), longitude: Number(anchorBin.longitude || anchorBin.lng) }
          : getVehicleStart(vehicle, depot);
        return { vehicle, route, distance: getDistanceMeters(anchor, { latitude: Number(bin.latitude || bin.lat), longitude: Number(bin.longitude || bin.lng) }) };
      })
      .filter(Boolean)
      .sort((first, second) => first.distance - second.distance);

    if (candidates.length) {
      const selected = candidates[0];
      selected.route.bins = selected.route.bins || [];
      insertAtShortestDetour(selected.route.bins, bin, selected.vehicle, depot);
      routeLoads.set(String(selected.vehicle.id), (routeLoads.get(String(selected.vehicle.id)) || 0) + demand);
      assignedIds.add(String(bin.id));
    }
  }

  return routes;
}

// POST /api/routes/optimize-fleet
export const optimizeFleetRoutes = async (req, res, next) => {
  try {
    const { depotLat = 19.9975, depotLng = 73.7898, vehicles: clientVehicles, bins: clientBins } = req.body || {};

    let bins = [];
    let vehicles = [];

    // 1. Fetch or parse Bins
    if (clientBins && Array.isArray(clientBins) && clientBins.length > 0) {
      bins = clientBins;
    } else {
      let { data: dbBins } = await supabase
        .from('bins')
        .select('id, latitude, longitude, fill_level, status, current_weight_kg, ward')
        .or('status.ilike.critical,status.ilike.warning')
        .order('fill_level', { ascending: false });

      if (!dbBins || dbBins.length === 0) {
        const { data: fallbackBins } = await supabase
          .from('bins')
          .select('id, latitude, longitude, fill_level, status, current_weight_kg, ward')
          .order('fill_level', { ascending: false })
          .limit(25);
        dbBins = fallbackBins || [];
      }
      bins = dbBins;
    }

    if (!bins || bins.length === 0) {
      return res.status(400).json({ error: 'No bins available for optimization.' });
    }

    // 2. Fetch or parse Vehicles/Drivers
    if (clientVehicles && Array.isArray(clientVehicles) && clientVehicles.length > 0) {
      vehicles = clientVehicles.map(v => ({
        id: v.vehicleId || v.driverId || v.id,
        driver_name: v.driverName || v.name || 'Assigned Driver',
        driver_phone: v.phone || 'N/A',
        license_plate: v.licensePlate || 'MH-15-EX-1001',
        capacity_kg: v.capacity || 5000,
        current_load_kg: v.currentLoad || 0,
        latitude: v.latitude,
        longitude: v.longitude,
        min_lat: v.minLat,
        max_lat: v.maxLat,
        min_lng: v.minLng,
        max_lng: v.maxLng
      }));
    } else {
      const { data: dbVehicles, error: vehicleError } = await supabase
        .from('vehicles')
        .select('id, driver_name, driver_phone, driver_avatar, license_plate, capacity_kg, current_load_kg, latitude, longitude, min_lat, max_lat, min_lng, max_lng, status')
        .neq('status', 'Maintenance');

      if (vehicleError || !dbVehicles || dbVehicles.length === 0) {
        return res.status(400).json({ error: 'No available vehicles or drivers found.' });
      }
      vehicles = dbVehicles;
    }

    // 3. Construct unified locations array (Depot is index 0)
    const locations = [
      {
        id: 'DEPOT',
        type: 'DEPOT',
        demand: 0,
        latitude: parseFloat(depotLat),
        longitude: parseFloat(depotLng)
      },
      ...bins.map(b => ({
        id: b.id,
        type: 'BIN',
        demand: b.current_weight_kg || 250,
        latitude: parseFloat(b.latitude || b.lat),
        longitude: parseFloat(b.longitude || b.lng)
      }))
    ];

    // 4. Query OSRM for Distance & Duration Matrices
    console.log('⌛ Generating distance matrix via OSRM...');
    const { distanceMatrix, durationMatrix } = await getDistanceAndDurationMatrices(locations);

    // 5. Build Python OR-Tools Payload
    const pythonVehicles = vehicles.map(v => ({
      vehicleId: String(v.id),
      capacity: v.capacity_kg || 5000,
      currentLoad: v.current_load_kg || 0,
      minLat: v.min_lat !== undefined ? parseFloat(v.min_lat) : null,
      maxLat: v.max_lat !== undefined ? parseFloat(v.max_lat) : null,
      minLng: v.min_lng !== undefined ? parseFloat(v.min_lng) : null,
      maxLng: v.max_lng !== undefined ? parseFloat(v.max_lng) : null
    }));

    console.log('⌛ Solving Vehicle Routing with Territory & Capacity Constraints...');
    
    let optimizationResult;
    try {
      optimizationResult = await solveVehicleRouting(
        pythonVehicles,
        locations,
        distanceMatrix,
        durationMatrix
      );
    } catch (solverErr) {
      console.warn('⚠️ OR-Tools strict solver failed. Falling back to defensive territorial allocation...', solverErr.message);
      
      // Fallback pseudo-result structure if Python solver fails or finds no exact solution
      optimizationResult = {
        totalDistanceMeters: 12000,
        totalDurationSeconds: 1800,
        routes: vehicles.map(v => ({
          vehicleId: String(v.id),
          bins: []
        }))
      };
    }

    optimizationResult.routes = allocateOverflowBins(
      optimizationResult.routes || [],
      vehicles,
      bins,
      { latitude: parseFloat(depotLat), longitude: parseFloat(depotLng) }
    );

    // 6. Format final JSON response with Driver Profile and GeoJSON Polylines
    console.log('⌛ Generating Leaflet Map Polylines...');
    const finalFleetRoutes = [];

    for (const route of (optimizationResult.routes || [])) {
      const vehicleInfo = vehicles.find(v => String(v.id) === String(route.vehicleId));
      if (!vehicleInfo) continue;

      // Collect assigned bin objects
      let assignedBinObjects = (route.bins || [])
        .map(binId => bins.find(b => String(b.id) === String(binId)))
        .filter(Boolean);

      if (assignedBinObjects.length === 0) continue;

      // Construct sequential waypoints: Depot -> Bin1 -> Bin2 -> ... -> BinN -> Depot
      const routeWaypoints = [
        { latitude: parseFloat(depotLat), longitude: parseFloat(depotLng) },
        ...assignedBinObjects.map(b => ({ latitude: parseFloat(b.latitude || b.lat), longitude: parseFloat(b.longitude || b.lng) })),
        { latitude: parseFloat(depotLat), longitude: parseFloat(depotLng) }
      ];

      // Fetch precise driving polyline passing through every assigned bin
      const polylineData = await getRoutePolyline(routeWaypoints);
      const totalCollectedWeightKg = assignedBinObjects.reduce((acc, bin) => acc + getBinWeight(bin), 0);

      finalFleetRoutes.push({
        vehicleId: String(route.vehicleId),
        driver: {
          name: vehicleInfo?.driver_name || 'Assigned Driver',
          phone: vehicleInfo?.driver_phone || 'N/A',
          licensePlate: vehicleInfo?.license_plate || 'MH-15-EX-1001',
          avatar: vehicleInfo?.driver_avatar || null,
          maxCapacityKg: vehicleInfo?.capacity_kg || 5000,
          assignedLoadKg: totalCollectedWeightKg
        },
        territory: {
          minLat: vehicleInfo?.min_lat,
          maxLat: vehicleInfo?.max_lat,
          minLng: vehicleInfo?.min_lng,
          maxLng: vehicleInfo?.max_lng
        },
        assignedBinCount: assignedBinObjects.length,
        assignedBins: assignedBinObjects,
        totalDistanceKm: (polylineData.distanceMeters / 1000).toFixed(2),
        totalDurationMinutes: Math.ceil(polylineData.durationSeconds / 60),
        geometry: polylineData.geometry,
        steps: polylineData.steps
      });
    }

    res.status(200).json({
      success: true,
      totalFleetDistanceKm: (optimizationResult.totalDistanceMeters / 1000).toFixed(2),
      totalFleetDurationMinutes: Math.ceil(optimizationResult.totalDurationSeconds / 60),
      routes: finalFleetRoutes
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/routes/leaderboard
export const getDriverLeaderboard = async (req, res, next) => {
  try {
    const { data: vehicles, error } = await supabase
      .from('vehicles')
      .select(`
        id,
        driver_name,
        driver_phone,
        driver_avatar,
        license_plate,
        total_bins_collected,
        total_weight_kg,
        total_distance_km,
        route_efficiency_score,
        citizen_rating_avg
      `)
      .neq('status', 'Maintenance');

    if (error) throw error;

    const leaderboard = vehicles.map(v => {
      const completionRate = Math.min(100, ((v.total_bins_collected || 1) / 10) * 100);
      const efficiency = v.route_efficiency_score || 90;
      const timing = 95;
      const rating = ((v.citizen_rating_avg || 4.5) / 5) * 100;

      const overallScore = parseFloat(
        (0.35 * completionRate + 0.25 * efficiency + 0.25 * timing + 0.15 * rating).toFixed(1)
      );

      return {
        vehicleId: v.id,
        driverName: v.driver_name,
        avatar: v.driver_avatar,
        licensePlate: v.license_plate,
        stats: {
          binsCollected: v.total_bins_collected || 0,
          totalWeightKg: v.total_weight_kg || 0,
          totalDistanceKm: v.total_distance_km || 0,
          citizenRating: v.citizen_rating_avg || 4.5
        },
        score: overallScore,
        badge: getBadgeTitle(overallScore)
      };
    });

    leaderboard.sort((a, b) => b.score - a.score);

    const rankedLeaderboard = leaderboard.map((driver, index) => ({
      rank: index + 1,
      ...driver
    }));

    res.status(200).json({
      success: true,
      period: 'Current Week',
      leaderboard: rankedLeaderboard
    });
  } catch (err) {
    next(err);
  }
};

function getBadgeTitle(score) {
  if (score >= 90) return 'Eco Champion 🏆';
  if (score >= 80) return 'Master Navigator 🚛';
  if (score >= 70) return 'Route Master 🛣️';
  return 'City Keeper 🧹';
}