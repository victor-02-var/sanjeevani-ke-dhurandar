-- ============================================================
-- Vehicle Portal Migration
-- Converts system from Authority-managed to Vehicle-specific portals
-- ============================================================

-- Step 1: Add authentication columns to vehicles table
ALTER TABLE public.vehicles 
  ADD COLUMN IF NOT EXISTS vehicle_username TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS vehicle_password_hash TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_qr_code TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_portal_active BOOLEAN DEFAULT TRUE;

-- Step 2: Create index for faster vehicle auth lookups
CREATE INDEX IF NOT EXISTS idx_vehicles_username ON public.vehicles(vehicle_username);
CREATE INDEX IF NOT EXISTS idx_vehicles_qr_code ON public.vehicles(vehicle_qr_code);

-- Step 3: Update QR system - link directly to vehicles
-- Modify dustbin_qr_codes to be simpler (or deprecate it)
-- Since vehicle has permanent QR, we'll track scans differently

-- Table: vehicle_scan_logs (replaces qr_scan_logs for vehicle-specific tracking)
CREATE TABLE IF NOT EXISTS public.vehicle_scan_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id        UUID NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  vehicle_qr_code   TEXT NOT NULL, -- Denormalized for quick lookup
  
  -- Citizen who scanned
  citizen_id        UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  citizen_name      TEXT,
  citizen_email     TEXT,
  
  -- Evidence
  garbage_image_url TEXT NOT NULL,
  
  -- Location
  scan_latitude     NUMERIC(10, 7) NOT NULL,
  scan_longitude    NUMERIC(10, 7) NOT NULL,
  scan_address      TEXT,
  
  -- Metadata
  scan_timestamp    TIMESTAMPTZ DEFAULT NOW(),
  device_info       TEXT,
  
  -- Verification
  verified_by_admin BOOLEAN DEFAULT FALSE,
  admin_notes       TEXT,
  verification_timestamp TIMESTAMPTZ,
  
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for vehicle_scan_logs
CREATE INDEX IF NOT EXISTS idx_vehicle_scan_logs_vehicle_id ON public.vehicle_scan_logs(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_scan_logs_qr_code ON public.vehicle_scan_logs(vehicle_qr_code);
CREATE INDEX IF NOT EXISTS idx_vehicle_scan_logs_citizen ON public.vehicle_scan_logs(citizen_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_scan_logs_timestamp ON public.vehicle_scan_logs(scan_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_scan_logs_verified ON public.vehicle_scan_logs(verified_by_admin);

-- Step 4: Enable RLS for vehicle_scan_logs
ALTER TABLE public.vehicle_scan_logs ENABLE ROW LEVEL SECURITY;

-- RLS: Vehicles can only see their own scan logs
CREATE POLICY "vehicle_scan_logs: vehicle own"
  ON public.vehicle_scan_logs FOR SELECT
  USING (
    vehicle_id IN (
      SELECT id FROM public.vehicles WHERE vehicle_username = current_setting('app.vehicle_username', true)
    )
  );

-- RLS: Citizens can insert scans
CREATE POLICY "vehicle_scan_logs: citizen insert"
  ON public.vehicle_scan_logs FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'citizen'
    )
  );

-- RLS: Citizens can view their own scans
CREATE POLICY "vehicle_scan_logs: citizen own"
  ON public.vehicle_scan_logs FOR SELECT
  USING (
    auth.uid() = citizen_id
  );

-- RLS: Admins can view and manage all scans
CREATE POLICY "vehicle_scan_logs: admin all"
  ON public.vehicle_scan_logs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Step 5: Function to generate vehicle credentials
CREATE OR REPLACE FUNCTION generate_vehicle_credentials(
  p_vehicle_id UUID,
  p_license_plate TEXT
)
RETURNS TABLE (
  vehicle_username TEXT,
  vehicle_password TEXT,
  vehicle_qr_code TEXT
) AS $$
DECLARE
  v_username TEXT;
  v_password TEXT;
  v_qr_code TEXT;
  v_password_hash TEXT;
BEGIN
  -- Generate username: VEH-{LICENSE_PLATE}
  v_username := 'VEH-' || UPPER(REPLACE(p_license_plate, ' ', ''));
  
  -- Generate random password (16 characters, alphanumeric)
  v_password := upper(substring(md5(random()::text) from 1 for 8)) || 
                lower(substring(md5(random()::text) from 1 for 8));
  
  -- Store a bcrypt hash so the API can verify the password securely.
  v_password_hash := crypt(v_password, gen_salt('bf', 12));
  
  -- Generate unique QR code: QR-{VEHICLE_ID}-{RANDOM}
  v_qr_code := 'QR-' || p_vehicle_id::text || '-' || substring(md5(random()::text) from 1 for 12);
  
  -- Update vehicle with generated credentials
  UPDATE public.vehicles
  SET 
    vehicle_username = v_username,
    vehicle_password_hash = v_password_hash,
    vehicle_qr_code = v_qr_code,
    qr_generated_at = NOW()
  WHERE id = p_vehicle_id;
  
  -- Return credentials (password only returned once!)
  RETURN QUERY SELECT v_username, v_password, v_qr_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 6: Function to verify vehicle login
CREATE OR REPLACE FUNCTION verify_vehicle_login(
  p_username TEXT,
  p_password TEXT
)
RETURNS TABLE (
  vehicle_id UUID,
  license_plate TEXT,
  is_active BOOLEAN,
  login_success BOOLEAN
) AS $$
DECLARE
  v_password_hash TEXT;
  v_vehicle RECORD;
BEGIN
  -- Hash provided password
  v_password_hash := encode(digest(p_password || 'salt', 'sha256'), 'hex');
  
  -- Find vehicle
  SELECT id, license_plate, is_portal_active
  INTO v_vehicle
  FROM public.vehicles
  WHERE vehicle_username = p_username
    AND vehicle_password_hash = v_password_hash;
  
  IF FOUND THEN
    -- Update last login
    UPDATE public.vehicles
    SET last_login_at = NOW()
    WHERE id = v_vehicle.id;
    
    -- Return success
    RETURN QUERY SELECT 
      v_vehicle.id,
      v_vehicle.license_plate,
      v_vehicle.is_portal_active,
      TRUE;
  ELSE
    -- Return failure
    RETURN QUERY SELECT 
      NULL::UUID,
      NULL::TEXT,
      FALSE,
      FALSE;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 7: View for vehicle dashboard stats
CREATE OR REPLACE VIEW public.vehicle_dashboard_stats AS
SELECT 
  v.id as vehicle_id,
  v.license_plate,
  v.status,
  v.territory_name,
  v.capacity_kg,
  v.current_load_kg,
  v.total_bins_collected,
  v.total_distance_km,
  v.route_efficiency_score,
  v.vehicle_qr_code,
  v.last_login_at,
  COUNT(vsl.id) as total_scans,
  COUNT(vsl.id) FILTER (WHERE vsl.verified_by_admin = TRUE) as verified_scans,
  COUNT(vsl.id) FILTER (WHERE vsl.scan_timestamp > NOW() - INTERVAL '24 hours') as scans_last_24h,
  MAX(vsl.scan_timestamp) as last_scan_at
FROM public.vehicles v
LEFT JOIN public.vehicle_scan_logs vsl ON vsl.vehicle_id = v.id
GROUP BY v.id;

-- Comments
COMMENT ON TABLE public.vehicle_scan_logs IS 'Logs of citizen scans for each vehicle QR code';
COMMENT ON FUNCTION generate_vehicle_credentials IS 'Generates username, password, and QR for a vehicle';
COMMENT ON FUNCTION verify_vehicle_login IS 'Verifies vehicle portal login credentials';
COMMENT ON VIEW public.vehicle_dashboard_stats IS 'Dashboard statistics for vehicle portal';

-- Step 8: Grant permissions
GRANT SELECT ON public.vehicle_dashboard_stats TO authenticated;
GRANT EXECUTE ON FUNCTION generate_vehicle_credentials TO service_role;
GRANT EXECUTE ON FUNCTION verify_vehicle_login TO anon, authenticated;
