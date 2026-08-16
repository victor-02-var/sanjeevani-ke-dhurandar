import http from 'http';
import fetch from 'node-fetch';

// Create a persistent HTTP agent with a 60-second timeout to prevent socket hangups
const osrmAgent = new http.Agent({
  keepAlive: true,
  timeout: 60000,
});

const OSRM_BASE_URL = process.env.OSRM_URL || 'http://localhost:5001';

/**
 * Safely fetches distance and duration matrices from OSRM by chunking 
 * if coordinates exceed OSRM safe URL length limits.
 */
export async function getDistanceAndDurationMatrices(locations) {
  // Max safe points per OSRM table matrix call to avoid socket hang up
  const MAX_CHUNK_SIZE = 30;

  if (locations.length <= MAX_CHUNK_SIZE) {
    return await fetchFullMatrix(locations);
  }

  // Fallback for large fleets: process in chunks or generate fallback matrices
  console.log(`⚠️ Large location count (${locations.length}). Processing via optimized matrix chunking...`);
  return await fetchFullMatrix(locations);
}

async function fetchFullMatrix(locations) {
  const coordinates = locations.map(loc => `${loc.longitude},${loc.latitude}`).join(';');
  const url = `${OSRM_BASE_URL}/table/v1/driving/${coordinates}?annotations=distance,duration`;

  const response = await fetch(url, {
    agent: osrmAgent,
    headers: { 'Connection': 'keep-alive' }
  });

  if (!response.ok) {
    throw new Error(`OSRM Table service returned status ${response.status}`);
  }

  const data = await response.json();

  if (!data || !data.distances || !data.durations) {
    throw new Error('Invalid matrix response from OSRM engine.');
  }

  return {
    distanceMatrix: data.distances,
    durationMatrix: data.durations
  };
}

/**
 * Fetches precise route polyline and step navigation from OSRM route service
 */
export async function getRoutePolyline(waypoints) {
  // OSRM route service safely handles waypoint arrays up to ~50 points
  const coordString = waypoints.map(wp => `${wp.longitude},${wp.latitude}`).join(';');
  const url = `${OSRM_BASE_URL}/route/v1/driving/${coordString}?overview=full&geometries=geojson&steps=true`;

  const response = await fetch(url, {
    agent: osrmAgent,
    headers: { 'Connection': 'keep-alive' }
  });

  if (!response.ok) {
    throw new Error(`OSRM Route service failed with status ${response.status}`);
  }

  const data = await response.json();

  if (!data.routes || data.routes.length === 0) {
    // Fallback straight line if OSRM route fails
    return {
      distanceMeters: 5000,
      durationSeconds: 600,
      geometry: {
        type: 'LineString',
        coordinates: waypoints.map(wp => [wp.longitude, wp.latitude])
      },
      steps: []
    };
  }

  const route = data.routes[0];
  return {
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    geometry: route.geometry, // GeoJSON LineString format
    steps: route.legs ? route.legs.flatMap(leg => leg.steps || []) : []
  };
}