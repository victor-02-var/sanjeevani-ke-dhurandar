import bcrypt from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY/SUPABASE_SERVICE_ROLE_KEY in .env file.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Mock Admin Data
const mockAdmins = [
  {
    full_name: 'Aditya Jadhav',
    email: 'admin@pmc.gov.in',
    password_raw: 'Admin@123',
    role: 'Super Admin'
  },
  {
    full_name: 'Rajesh Sharma',
    email: 'r.sharma@pmc.gov.in',
    password_raw: 'PmcPass#2026',
    role: 'Fleet Manager'
  },
  {
    full_name: 'Priya Verma',
    email: 'p.verma@pmc.gov.in',
    password_raw: 'PmcPass#2026',
    role: 'Grievance Officer'
  }
];

async function seedAdmins() {
  console.log('⌛ Preparing admin records with bcrypt password hashing...');

  try {
    const adminInserts = await Promise.all(
      mockAdmins.map(async (admin) => {
        const password_hash = await bcrypt.hash(admin.password_raw, 10);
        return {
          full_name: admin.full_name,
          email: admin.email,
          password_hash,
          role: admin.role,
        };
      })
    );

    console.log('⌛ Inserting admins into Supabase...');

    // Upsert into 'admins' table on email conflict
    const { data, error } = await supabase
      .from('admins')
      .upsert(adminInserts, { onConflict: 'email' })
      .select('id, full_name, email, role, created_at');

    if (error) {
      throw error;
    }

    console.log('\n✅ Mock admins seeded successfully!\n');
    console.table(
      mockAdmins.map((a) => ({
        'Full Name': a.full_name,
        Email: a.email,
        'Raw Password': a.password_raw,
        Role: a.role,
      }))
    );
  } catch (err) {
    console.error('❌ Failed to seed admins:', err.message);
  } finally {
    process.exit(0);
  }
}

seedAdmins();