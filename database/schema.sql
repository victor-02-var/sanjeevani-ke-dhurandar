-- ============================================================
-- CivicSync - Complete Database Schema (Supabase Auth)
-- Run this in Supabase SQL Editor → Query tab
-- Auth is handled fully by Supabase (no custom password_hash)
-- Covers: Admin Dashboard, Citizen Dashboard, Vehicle Dashboard
-- ============================================================


-- ============================================================
-- SECTION 1: EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ============================================================
-- SECTION 2: PROFILES TABLE
-- One row per user, linked to auth.users.
-- role column drives which dashboard the user sees.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   TEXT,
  email       TEXT UNIQUE NOT NULL,
  phone       TEXT,
  avatar_url  TEXT,
  role        TEXT NOT NULL DEFAULT 'citizen',
  -- role values: 'admin', 'citizen', 'driver', 'vehicle_authority'
  address     TEXT,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- SECTION 3: CITIZEN DASHBOARD TABLES
-- ============================================================

-- 3.1 Complaints (filed by citizens, managed by admin, assigned to drivers)
CREATE TABLE IF NOT EXISTS public.complaints (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id          UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_driver_id  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  latitude            NUMERIC(10, 7) NOT NULL,
  longitude           NUMERIC(10, 7) NOT NULL,
  description         TEXT,
  image_url           TEXT,
  resolved_image_url  TEXT,
  status              TEXT NOT NULL DEFAULT 'Open',
  -- values: 'Open', 'Under Review', 'Assigned', 'In Progress', 'Resolved', 'Closed'
  priority            TEXT NOT NULL DEFAULT 'High',
  -- values: 'Low', 'Medium', 'High', 'Critical'
  category            TEXT NOT NULL DEFAULT 'Roadside Litter',
  ai_confidence       NUMERIC(5, 4) DEFAULT 0.95,
  ai_reason           TEXT,
  gps_source          TEXT DEFAULT 'USER_PIN',
  -- values: 'EXIF_METADATA', 'USER_PIN'
  resolution_notes    TEXT,
  timeline_visible    BOOLEAN DEFAULT TRUE,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- 3.2 Complaint timelines (step-by-step progress visible to citizen)
CREATE TABLE IF NOT EXISTS public.complaint_timelines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE CASCADE,
  event        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 3.3 Citizen quick reports (lightweight garbage image reports)
CREATE TABLE IF NOT EXISTS public.citizen_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  image_url     TEXT NOT NULL,
  latitude      NUMERIC(10, 7) NOT NULL,
  longitude     NUMERIC(10, 7) NOT NULL,
  gps_source    TEXT DEFAULT 'USER_PIN',
  category      TEXT,
  ai_confidence NUMERIC(5, 4),
  ai_reason     TEXT,
  status        TEXT DEFAULT 'Verified',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 3.4 Carbon cards (eco-reward points for citizens)
CREATE TABLE IF NOT EXISTS public.carbon_cards (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id       UUID UNIQUE NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  total_points     INTEGER DEFAULT 0,
  redeemed_points  INTEGER DEFAULT 0,
  available_points INTEGER GENERATED ALWAYS AS (total_points - redeemed_points) STORED,
  tier             TEXT NOT NULL DEFAULT 'Bronze',
  -- values: 'Bronze', 'Silver', 'Gold', 'Platinum'
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- SECTION 4: VEHICLE / DRIVER DASHBOARD TABLES
-- ============================================================

-- 4.1 Driver profiles (extra info beyond what profiles holds)
CREATE TABLE IF NOT EXISTS public.driver_profiles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id             UUID UNIQUE NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  mobile_number         TEXT NOT NULL,
  address               TEXT NOT NULL,
  driving_license_photo TEXT,
  driving_experience    TEXT NOT NULL,
  -- values: 'none', '2-3 years', 'more than 3 years'
  vehicle_type          TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- 4.2 Vehicles (garbage trucks — each linked to a driver profile and optionally to a vehicle authority)
CREATE TABLE IF NOT EXISTS public.vehicles (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id              UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  authority_id           UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  driver_name            TEXT,
  driver_phone           TEXT,
  driver_avatar          TEXT,
  license_plate          TEXT UNIQUE NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'Active',
  -- values: 'Active', 'Idle', 'Maintenance', 'Offline'
  capacity_kg            NUMERIC(8, 2) DEFAULT 5000,
  current_load_kg        NUMERIC(8, 2) DEFAULT 0,
  latitude               NUMERIC(10, 7),
  longitude              NUMERIC(10, 7),
  speed                  NUMERIC(6, 2) DEFAULT 0,

  -- Territory bounding box for route optimizer
  territory_name         TEXT,
  min_lat                NUMERIC(10, 7),
  max_lat                NUMERIC(10, 7),
  min_lng                NUMERIC(10, 7),
  max_lng                NUMERIC(10, 7),

  -- Leaderboard / performance metrics
  total_bins_collected   INTEGER DEFAULT 0,
  total_weight_kg        NUMERIC(10, 2) DEFAULT 0,
  total_distance_km      NUMERIC(10, 2) DEFAULT 0,
  route_efficiency_score NUMERIC(5, 2) DEFAULT 90,
  citizen_rating_avg     NUMERIC(3, 2) DEFAULT 4.5,

  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- 4.3 Bins (smart dustbins with IoT fill-level telemetry)
CREATE TABLE IF NOT EXISTS public.bins (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ward               TEXT DEFAULT 'Shivajinagar',
  zone               TEXT DEFAULT 'Zone A',
  latitude           NUMERIC(10, 7) NOT NULL,
  longitude          NUMERIC(10, 7) NOT NULL,
  fill_level         INTEGER DEFAULT 0 CHECK (fill_level >= 0 AND fill_level <= 100),
  current_weight_kg  NUMERIC(8, 2) DEFAULT 0,
  status             TEXT DEFAULT 'Normal',
  -- values: 'Normal', 'Warning', 'Critical'
  priority_score     NUMERIC(6, 2) DEFAULT 0,
  assigned_driver_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,
  last_collected     TIMESTAMPTZ DEFAULT NOW(),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- 4.4 Collections (log every bin collection event by a driver)
CREATE TABLE IF NOT EXISTS public.collections (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bin_id                 UUID NOT NULL REFERENCES public.bins(id) ON DELETE CASCADE,
  vehicle_id             UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,
  before_level           INTEGER,
  after_level            INTEGER DEFAULT 0,
  verification_photo_url TEXT,
  timestamp              TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- SECTION 5: INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_profiles_role         ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_email        ON public.profiles(email);

CREATE INDEX IF NOT EXISTS idx_complaints_citizen    ON public.complaints(citizen_id);
CREATE INDEX IF NOT EXISTS idx_complaints_driver     ON public.complaints(assigned_driver_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status     ON public.complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_created    ON public.complaints(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_timelines_complaint   ON public.complaint_timelines(complaint_id);

CREATE INDEX IF NOT EXISTS idx_bins_status           ON public.bins(status);
CREATE INDEX IF NOT EXISTS idx_bins_driver           ON public.bins(assigned_driver_id);
CREATE INDEX IF NOT EXISTS idx_bins_fill             ON public.bins(fill_level DESC);

CREATE INDEX IF NOT EXISTS idx_collections_bin       ON public.collections(bin_id);
CREATE INDEX IF NOT EXISTS idx_collections_vehicle   ON public.collections(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_collections_time      ON public.collections(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_vehicles_status       ON public.vehicles(status);
CREATE INDEX IF NOT EXISTS idx_vehicles_driver       ON public.vehicles(driver_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_authority    ON public.vehicles(authority_id);

CREATE INDEX IF NOT EXISTS idx_carbon_citizen        ON public.carbon_cards(citizen_id);
CREATE INDEX IF NOT EXISTS idx_driver_profiles_id    ON public.driver_profiles(driver_id);


-- ============================================================
-- SECTION 6: UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles', 'complaints', 'driver_profiles', 'vehicles', 'bins'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_set_updated_at ON public.%I;
       CREATE TRIGGER trg_set_updated_at
       BEFORE UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();',
      t, t
    );
  END LOOP;
END $$;


-- ============================================================
-- SECTION 7: AUTO-CREATE PROFILE ON SUPABASE AUTH SIGNUP
-- Fires after every new user is created in auth.users.
-- Reads role from user_metadata so signup can pass 'admin',
-- 'citizen', or 'driver' and get routed correctly.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'role', 'citizen'),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ============================================================
-- SECTION 8: AUTO-CREATE CARBON CARD FOR CITIZEN ON SIGNUP
-- Fires after a new profile is inserted with role = 'citizen'
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_citizen()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role = 'citizen' THEN
    INSERT INTO public.carbon_cards (citizen_id, total_points, redeemed_points, tier)
    VALUES (NEW.id, 0, 0, 'Bronze')
    ON CONFLICT (citizen_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_citizen_profile_created ON public.profiles;
CREATE TRIGGER on_citizen_profile_created
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_citizen();


-- ============================================================
-- SECTION 9: STORAGE BUCKET (garbage-reports)
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'garbage-reports',
  'garbage-reports',
  true,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/jpg']
)
ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- SECTION 10: ROW LEVEL SECURITY POLICIES
-- ============================================================

ALTER TABLE public.profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaints        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_timelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.citizen_reports   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carbon_cards      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bins              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collections       ENABLE ROW LEVEL SECURITY;

-- ── profiles ────────────────────────────────────────────────
-- Users can read and update only their own profile
DROP POLICY IF EXISTS "profiles: own read"   ON public.profiles;
DROP POLICY IF EXISTS "profiles: own update" ON public.profiles;
DROP POLICY IF EXISTS "profiles: admin all"  ON public.profiles;

CREATE POLICY "profiles: own read"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "profiles: own update"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

-- Admins can read all profiles
CREATE POLICY "profiles: admin all"
  ON public.profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- ── complaints ───────────────────────────────────────────────
DROP POLICY IF EXISTS "complaints: citizen own"   ON public.complaints;
DROP POLICY IF EXISTS "complaints: citizen insert" ON public.complaints;
DROP POLICY IF EXISTS "complaints: admin all"     ON public.complaints;
DROP POLICY IF EXISTS "complaints: driver assigned" ON public.complaints;

-- Citizens see only their own complaints
CREATE POLICY "complaints: citizen own"
  ON public.complaints FOR SELECT
  USING (auth.uid() = citizen_id);

-- Citizens can file new complaints
CREATE POLICY "complaints: citizen insert"
  ON public.complaints FOR INSERT
  WITH CHECK (auth.uid() = citizen_id);

-- Admins can read/update all complaints
CREATE POLICY "complaints: admin all"
  ON public.complaints FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Drivers can see complaints assigned to them
CREATE POLICY "complaints: driver assigned"
  ON public.complaints FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.vehicles v
      WHERE v.driver_id = auth.uid()
        AND v.id = complaints.assigned_driver_id
    )
  );

-- ── complaint_timelines ──────────────────────────────────────
DROP POLICY IF EXISTS "timelines: citizen read"  ON public.complaint_timelines;
DROP POLICY IF EXISTS "timelines: admin all"     ON public.complaint_timelines;

-- Citizens can read timelines for their own complaints
CREATE POLICY "timelines: citizen read"
  ON public.complaint_timelines FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = complaint_timelines.complaint_id
        AND c.citizen_id = auth.uid()
        AND c.timeline_visible = true
    )
  );

-- Admins can manage all timelines
CREATE POLICY "timelines: admin all"
  ON public.complaint_timelines FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- ── citizen_reports ──────────────────────────────────────────
DROP POLICY IF EXISTS "reports: citizen own"    ON public.citizen_reports;
DROP POLICY IF EXISTS "reports: citizen insert" ON public.citizen_reports;
DROP POLICY IF EXISTS "reports: admin all"      ON public.citizen_reports;

CREATE POLICY "reports: citizen own"
  ON public.citizen_reports FOR SELECT
  USING (auth.uid() = citizen_id);

CREATE POLICY "reports: citizen insert"
  ON public.citizen_reports FOR INSERT
  WITH CHECK (auth.uid() = citizen_id);

CREATE POLICY "reports: admin all"
  ON public.citizen_reports FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- ── carbon_cards ─────────────────────────────────────────────
DROP POLICY IF EXISTS "carbon: citizen own"  ON public.carbon_cards;
DROP POLICY IF EXISTS "carbon: admin all"    ON public.carbon_cards;

CREATE POLICY "carbon: citizen own"
  ON public.carbon_cards FOR SELECT
  USING (auth.uid() = citizen_id);

CREATE POLICY "carbon: admin all"
  ON public.carbon_cards FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- ── driver_profiles ──────────────────────────────────────────
DROP POLICY IF EXISTS "driver_profiles: own"      ON public.driver_profiles;
DROP POLICY IF EXISTS "driver_profiles: admin all" ON public.driver_profiles;

CREATE POLICY "driver_profiles: own"
  ON public.driver_profiles FOR ALL
  USING (auth.uid() = driver_id);

CREATE POLICY "driver_profiles: admin all"
  ON public.driver_profiles FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- ── vehicles ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "vehicles: driver own"  ON public.vehicles;
DROP POLICY IF EXISTS "vehicles: admin all"   ON public.vehicles;
DROP POLICY IF EXISTS "vehicles: public read" ON public.vehicles;
DROP POLICY IF EXISTS "vehicles: authority own" ON public.vehicles;

-- Drivers see only their own vehicle
CREATE POLICY "vehicles: driver own"
  ON public.vehicles FOR SELECT
  USING (auth.uid() = driver_id);

-- Admins manage all vehicles
CREATE POLICY "vehicles: admin all"
  ON public.vehicles FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Vehicle authorities can manage their assigned vehicles
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

-- Anyone authenticated can read vehicles (for live tracking on citizen dashboard)
CREATE POLICY "vehicles: public read"
  ON public.vehicles FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- ── bins ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "bins: authenticated read" ON public.bins;
DROP POLICY IF EXISTS "bins: admin all"          ON public.bins;
DROP POLICY IF EXISTS "bins: driver own"         ON public.bins;

-- Any logged-in user can read bins (citizen live tracking)
CREATE POLICY "bins: authenticated read"
  ON public.bins FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Admins manage all bins
CREATE POLICY "bins: admin all"
  ON public.bins FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Drivers can update bins assigned to them
CREATE POLICY "bins: driver own"
  ON public.bins FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.vehicles v
      WHERE v.driver_id = auth.uid() AND v.id = bins.assigned_driver_id
    )
  );

-- ── collections ──────────────────────────────────────────────
DROP POLICY IF EXISTS "collections: admin all"  ON public.collections;
DROP POLICY IF EXISTS "collections: driver own" ON public.collections;

CREATE POLICY "collections: admin all"
  ON public.collections FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

CREATE POLICY "collections: driver own"
  ON public.collections FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.vehicles v
      WHERE v.driver_id = auth.uid() AND v.id = collections.vehicle_id
    )
  );

-- ── storage: garbage-reports ─────────────────────────────────
DROP POLICY IF EXISTS "storage: public read"    ON storage.objects;
DROP POLICY IF EXISTS "storage: auth upload"    ON storage.objects;

-- Anyone can view uploaded images
CREATE POLICY "storage: public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'garbage-reports');

-- Any logged-in user can upload (citizens + drivers)
CREATE POLICY "storage: auth upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'garbage-reports' AND auth.uid() IS NOT NULL
  );
