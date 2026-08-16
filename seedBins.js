import { supabase } from './src/config/supabase.js'

/**
 * Checks if a point (lat, lng) falls inside any vehicle's bounding box
 */
function isInsideAnyTerritory(lat, lng, vehicles) {
  return vehicles.some((v) => {
    const minLat = parseFloat(v.min_lat || 19.9800);
    const maxLat = parseFloat(v.max_lat || 20.0200);
    const minLng = parseFloat(v.min_lng || 73.7500);
    const maxLng = parseFloat(v.max_lng || 73.8100);

    return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
  });
}

async function seedTerritoryAndOutlierBins() {
  console.log('⌛ Fetching active driver territories from database...');

  // 1. Fetch vehicles with territory bounds
  const { data: vehicles, error: vErr } = await supabase
    .from('vehicles')
    .select('id, driver_name, territory_name, min_lat, max_lat, min_lng, max_lng');

  if (vErr || !vehicles || vehicles.length === 0) {
    console.error('❌ Failed to fetch vehicles or no territories found:', vErr);
    process.exit(1);
  }

  // 2. Clear old dustbins
  await supabase.from('bins').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  const BINS_PER_TERRITORY = 6;
  const newBins = [];

  // 3. Generate dustbins uniformly INSIDE each driver's assigned box
  vehicles.forEach((v) => {
    const minLat = parseFloat(v.min_lat || 19.9800);
    const maxLat = parseFloat(v.max_lat || 20.0200);
    const minLng = parseFloat(v.min_lng || 73.7500);
    const maxLng = parseFloat(v.max_lng || 73.8100);

    for (let i = 1; i <= BINS_PER_TERRITORY; i++) {
      const lat = minLat + Math.random() * (maxLat - minLat);
      const lng = minLng + Math.random() * (maxLng - minLng);
      const fillLevel = Math.floor(Math.random() * 45) + 55; // 55% - 100%

      newBins.push({
        ward: v.territory_name || 'Nashik Central',
        assigned_driver_id: v.id,
        latitude: parseFloat(lat.toFixed(6)),
        longitude: parseFloat(lng.toFixed(6)),
        fill_level: fillLevel,
        current_weight_kg: Math.floor(fillLevel * 3.5),
      });
    }
  });

  // 4. Generate 2 to 5 OUTLIER dustbins strictly OUTSIDE all territories
  const numOutliers = Math.floor(Math.random() * 4) + 2; // Random count between 2 and 5
  console.log(`⌛ Generating ${numOutliers} outlier bins outside all assigned driver boundaries...`);

  // General Nashik outer bounding box for fallback placement
  const NASHIK_OUTER_BOUNDS = {
    minLat: 19.9500,
    maxLat: 20.0500,
    minLng: 73.7000,
    maxLng: 73.8500,
  };

  let createdOutliers = 0;
  let attempts = 0;

  while (createdOutliers < numOutliers && attempts < 200) {
    attempts++;
    const lat = NASHIK_OUTER_BOUNDS.minLat + Math.random() * (NASHIK_OUTER_BOUNDS.maxLat - NASHIK_OUTER_BOUNDS.minLat);
    const lng = NASHIK_OUTER_BOUNDS.minLng + Math.random() * (NASHIK_OUTER_BOUNDS.maxLng - NASHIK_OUTER_BOUNDS.minLng);

    // Ensure coordinate is NOT inside any active driver's territory
    if (!isInsideAnyTerritory(lat, lng, vehicles)) {
      const fillLevel = Math.floor(Math.random() * 40) + 60; // High fill level (60% - 100%)

      newBins.push({
        ward: 'Unassigned Outer Zone',
        assigned_driver_id: null, // No driver assigned
        latitude: parseFloat(lat.toFixed(6)),
        longitude: parseFloat(lng.toFixed(6)),
        fill_level: fillLevel,
        current_weight_kg: Math.floor(fillLevel * 3.5),
      });

      createdOutliers++;
    }
  }

  // 5. Insert all bins back into Supabase
  const { data: insertedBins, error: bErr } = await supabase
    .from('bins')
    .insert(newBins)
    .select();

  if (bErr) {
    console.error('❌ Error inserting bins:', bErr.message);
    process.exit(1);
  }

  console.log(`✅ Seeded ${insertedBins.length} total bins (${vehicles.length * BINS_PER_TERRITORY} territory bins + ${createdOutliers} unassigned outlier bins)!`);
  process.exit(0);
}

seedTerritoryAndOutlierBins();