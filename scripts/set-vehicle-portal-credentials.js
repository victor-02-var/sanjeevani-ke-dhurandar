import bcrypt from 'bcrypt';
import { supabaseAdmin } from '../src/config/supabase.js';

const [licensePlateArgument, password] = process.argv.slice(2);
const licensePlate = licensePlateArgument?.trim().toUpperCase();

if (!licensePlate || !password) {
  console.error('Usage: node scripts/set-vehicle-portal-credentials.js <license-plate> <new-password>');
  process.exit(1);
}

if (password.length < 8) {
  console.error('The new password must contain at least 8 characters.');
  process.exit(1);
}

const { data: vehicle, error: lookupError } = await supabaseAdmin
  .from('vehicles')
  .select('id, license_plate')
  .eq('license_plate', licensePlate)
  .maybeSingle();

if (lookupError) {
  throw lookupError;
}

if (!vehicle) {
  console.error(`No vehicle found for license plate ${licensePlate}.`);
  process.exit(1);
}

const username = `VEH-${licensePlate.replace(/\s+/g, '')}`;
const passwordHash = await bcrypt.hash(password, 12);
const { error: updateError } = await supabaseAdmin
  .from('vehicles')
  .update({
    vehicle_username: username,
    vehicle_password_hash: passwordHash,
    is_portal_active: true,
  })
  .eq('id', vehicle.id);

if (updateError) {
  throw updateError;
}

console.log(`Vehicle portal credentials updated for ${licensePlate}.`);
console.log(`Username: ${username}`);