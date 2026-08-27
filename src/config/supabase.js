import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
}

if (!supabaseServiceKey || supabaseServiceKey === 'your-service-role-key-here') {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in .env — get it from Supabase → Settings → API');
}

// Public client — used for auth (signUp, signInWithPassword, etc.)
// Respects RLS policies
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Admin client — uses service role key, bypasses RLS
// Used for server-side DB operations (insert, update, select across all rows)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
