import http from 'http';
import https from 'https';
import fetch from 'node-fetch';

// Persistent HTTP agents
const httpAgent  = new http.Agent({ keepAlive: true, timeout: 60000 });
const httpsAgent = new https.Agent({ keepAlive: true, timeout: 60000 });

/**
 * OSRM base URL.
 * - In production (self-hosted): set OSRM_URL=http://localhost:5001
 * - In development / mock mode: defaults to the public OSRM demo server
 */
const OSRM_BASE_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';

function getAgent(url) {
  return url.startsWith('https') ? httpsAgent : httpAgent;
}

/**
 * Builds a straight-line GeoJSON LineString from an ordered list of locations.
 * Used as a fallback when OSRM is unreachable.
 */
function straightLineFallback(locations) {
  const coordinates = locations.map(loc => [
    parseFloat(loc.longitude),
    parseFloat(loc.latitude),
  ]);

  // Very rough distance estimate using haversine between first and last point
  let totalMeters = 0;
  for (let i = 1; i < locations.length; i++) {
    totalMeters += haversineMeters(
      parseFloat(locations[i - 1].latitude), parseFloat(locations[i - 1].longitude),
      parseFloat(locations[i].latitude),     parseFloat(locations[i].longitude)
    );
  }

  return {
    distanceMeters: Math.round(totalMeters),
    durationSeconds: Math.round(totalMeters / 8), // ~28 km/h average city speed
    geometry: { type: 'LineString', coordinates },
    steps: [],
  };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Fetch distance + duration matrices from OSRM.
 * Falls back to straight-line estimates if OSRM is unreachable.
 */
export async function getDistanceAndDurationMatrices(locations) {
  try {
    const coordinates = locations.map(l => `${l.longitude},${l.latitude}`).join(';');
    const url = `${OSRM_BASE_URL}/table/v1/driving/${coordinates}?annotations=distance,duration`;

    const response = await fetch(url, {
      agent: getAgent(url),
      headers: { 'Connection': 'keep-alive' },
      timeout: 15000,
    });

    if (!response.ok) throw new Error(`OSRM table status ${response.status}`);

    const data = await response.json();
    if (!data?.distances || !data?.durations) throw new Error('Invalid OSRM matrix response');

    return { distanceMatrix: data.distances, durationMatrix: data.durations };
  } catch (err) {
    console.warn(`⚠️ OSRM table unavailable (${err.message}). Using haversine straight-line fallback.`);

    // Build NxN haversine matrix
    const n = locations.length;
    const distanceMatrix = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) =>
        i === j ? 0 : haversineMeters(
          parseFloat(locations[i].latitude), parseFloat(locations[i].longitude),
          parseFloat(locations[j].latitude), parseFloat(locations[j].longitude)
        )
      )
    );
    const durationMatrix = distanceMatrix.map(row => row.map(d => Math.round(d / 8)));

    return { distanceMatrix, durationMatrix };
  }
}

/**
 * Fetch a precise driving polyline from OSRM for an ordered list of waypoints.
 * Falls back to straight-line GeoJSON if OSRM is unreachable.
 * Automatically chunks into segments of ≤ 25 waypoints to stay within URL limits.
 */
export async function getRoutePolyline(waypoints) {
  if (!waypoints || waypoints.length < 2) {
    return straightLineFallback(waypoints || []);
  }

  // Chunk waypoints into segments of max 25 to avoid URL length limits on public OSRM
  const MAX_CHUNK = 25;
  const chunks = [];
  for (let i = 0; i < waypoints.length - 1; i += MAX_CHUNK - 1) {
    chunks.push(waypoints.slice(i, i + MAX_CHUNK));
    if (chunks[chunks.length - 1].length < 2) {
      // Merge tiny tail into previous chunk
      chunks[chunks.length - 2] = [...chunks[chunks.length - 2], ...chunks.pop()];
    }
  }

  let totalDistance = 0;
  let totalDuration = 0;
  const allCoordinates = [];
  const allSteps = [];

  for (const chunk of chunks) {
    const coordString = chunk.map(wp => `${wp.longitude},${wp.latitude}`).join(';');
    const url = `${OSRM_BASE_URL}/route/v1/driving/${coordString}?overview=full&geometries=geojson&steps=false`;

    try {
      const response = await fetch(url, {
        agent: getAgent(url),
        headers: { 'Connection': 'keep-alive' },
        timeout: 15000,
      });

      if (!response.ok) throw new Error(`OSRM route status ${response.status}`);

      const data = await response.json();
      if (!data?.routes?.length) throw new Error('No routes returned');

      const route = data.routes[0];
      totalDistance += route.distance || 0;
      totalDuration += route.duration || 0;

      const coords = route.geometry?.coordinates || chunk.map(wp => [wp.longitude, wp.latitude]);
      // Avoid duplicating shared waypoints between chunks
      allCoordinates.push(...(allCoordinates.length > 0 ? coords.slice(1) : coords));
    } catch (chunkErr) {
      console.warn(`⚠️ OSRM chunk failed (${chunkErr.message}). Using straight-line for this segment.`);
      const fallback = straightLineFallback(chunk);
      totalDistance += fallback.distanceMeters;
      totalDuration += fallback.durationSeconds;
      const coords = fallback.geometry.coordinates;
      allCoordinates.push(...(allCoordinates.length > 0 ? coords.slice(1) : coords));
    }
  }

  if (allCoordinates.length === 0) {
    return straightLineFallback(waypoints);
  }

  return {
    distanceMeters: Math.round(totalDistance),
    durationSeconds: Math.round(totalDuration),
    geometry: { type: 'LineString', coordinates: allCoordinates },
    steps: allSteps,
  };
}