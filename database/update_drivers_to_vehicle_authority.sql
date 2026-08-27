-- ============================================================
-- Migration: Update Driver Role to Vehicle Authority
-- Purpose: Consolidate driver and vehicle_authority into one role
-- ============================================================

-- Step 1: Update all existing drivers to vehicle_authority role
UPDATE profiles 
SET role = 'vehicle_authority' 
WHERE role = 'driver';

-- Step 2: Update comments to reflect new terminology
COMMENT ON COLUMN vehicles.driver_id IS 'References vehicle authority (role=vehicle_authority) who operates this vehicle';
COMMENT ON COLUMN vehicles.driver_name IS 'Name of the vehicle authority operating this vehicle';
COMMENT ON COLUMN vehicles.driver_phone IS 'Phone number of the vehicle authority';

-- Step 3: Verify the changes
SELECT 
  'Updated ' || COUNT(*) || ' profiles from driver to vehicle_authority' as result
FROM profiles 
WHERE role = 'vehicle_authority';

-- Step 4: Show all vehicle authorities and their vehicles
SELECT 
  p.id,
  p.email,
  p.full_name,
  p.role,
  v.license_plate,
  v.territory_name
FROM profiles p
LEFT JOIN vehicles v ON v.driver_id = p.id
WHERE p.role = 'vehicle_authority'
ORDER BY p.created_at DESC;

-- Note: The RLS policies already check for 'driver' or 'vehicle_authority'
-- so existing policies should continue to work
