-- ============================================================
-- Migration: Add Vehicle Authority Role Support
-- Description: Adds vehicle_authority role and authority_id to vehicles table
-- Date: 2026-08-26
-- ============================================================

-- Add authority_id column to vehicles table
ALTER TABLE public.vehicles 
ADD COLUMN IF NOT EXISTS authority_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Create index for authority_id
CREATE INDEX IF NOT EXISTS idx_vehicles_authority ON public.vehicles(authority_id);

-- Update the vehicles RLS policy to include vehicle authority access
DROP POLICY IF EXISTS "vehicles: authority own" ON public.vehicles;

CREATE POLICY "vehicles: authority own"
  ON public.vehicles FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() 
        AND p.role = 'vehicle_authority'
        AND p.id = vehicles.authority_id
    )
  );

-- Add comment to document the new role
COMMENT ON COLUMN public.profiles.role IS 'User role: admin, citizen, driver, vehicle_authority';

-- Success message
DO $$
BEGIN
  RAISE NOTICE 'Vehicle authority role support added successfully!';
  RAISE NOTICE 'You can now create vehicle authority accounts via: POST /api/auth/admin/create-vehicle-authority';
END $$;
