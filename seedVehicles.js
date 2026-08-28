import { supabase } from './src/config/supabase.js';
import { generateMockVehicles } from './src/utils/mockVehicleGenerator.js';

async function seedVehicles() {
  console.log('⌛ Seeding 8 garbage trucks into Supabase...');
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

  console.log(`✅ Successfully seeded ${vehicles.length} vehicles to Supabase!`);
  process.exit(0);
}

seedVehicles();