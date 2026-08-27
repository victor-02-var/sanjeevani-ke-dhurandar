-- Fix RLS on vehicle_scan_logs
-- The service role (supabaseAdmin) should bypass RLS, but some Supabase versions
-- require explicit policies. This adds a permissive insert policy for all users
-- (since scan submissions are intentionally public/anonymous).

-- Drop any existing conflicting policies
DROP POLICY IF EXISTS "vehicle_scan_logs_insert" ON vehicle_scan_logs;
DROP POLICY IF EXISTS "vehicle_scan_logs_select" ON vehicle_scan_logs;
DROP POLICY IF EXISTS "Allow insert for authenticated users" ON vehicle_scan_logs;
DROP POLICY IF EXISTS "Allow select for vehicle authority" ON vehicle_scan_logs;

-- Allow anyone to insert (citizens scan without login)
CREATE POLICY "vehicle_scan_logs_insert_public"
  ON vehicle_scan_logs
  FOR INSERT
  TO public
  WITH CHECK (true);

-- Allow authenticated users to read their own scans
CREATE POLICY "vehicle_scan_logs_select_own"
  ON vehicle_scan_logs
  FOR SELECT
  TO authenticated
  USING (citizen_id = auth.uid());

-- Allow service role full access (covers backend supabaseAdmin)
CREATE POLICY "vehicle_scan_logs_service_role_all"
  ON vehicle_scan_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Allow admins to read all scans
CREATE POLICY "vehicle_scan_logs_select_admin"
  ON vehicle_scan_logs
  FOR SELECT
  TO authenticated
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  );

-- Allow vehicle authority to read scans for their vehicles
CREATE POLICY "vehicle_scan_logs_select_vehicle_authority"
  ON vehicle_scan_logs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM vehicles
      WHERE vehicles.id = vehicle_scan_logs.vehicle_id
        AND vehicles.driver_id = auth.uid()
    )
  );
