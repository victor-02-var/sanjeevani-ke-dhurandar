import { supabaseAdmin } from '../src/config/supabase.js';

const [emailArgument, password] = process.argv.slice(2);
const email = emailArgument?.trim().toLowerCase();

if (!email || !password) {
  console.error('Usage: node scripts/set-admin-password.js <email> <new-password>');
  process.exit(1);
}

if (password.length < 8) {
  console.error('The new password must contain at least 8 characters.');
  process.exit(1);
}

const { data: profile, error: profileError } = await supabaseAdmin
  .from('profiles')
  .select('id, email, role, is_active')
  .eq('email', email)
  .maybeSingle();

if (profileError) {
  throw profileError;
}

if (!profile) {
  console.error(`No profile found for ${email}.`);
  process.exit(1);
}

if (profile.role !== 'admin') {
  console.error(`Refusing to change ${email}: profile role is ${profile.role}.`);
  process.exit(1);
}

if (!profile.is_active) {
  console.error(`Refusing to change ${email}: the account is inactive.`);
  process.exit(1);
}

const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(profile.id, {
  password,
  email_confirm: true,
});

if (updateError) {
  throw updateError;
}

console.log(`Admin password reset successfully for ${email}.`);