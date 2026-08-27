-- Carbon points wallet migration for Supabase/PostgreSQL.
-- Run this once in the Supabase SQL Editor.
-- Admins do not own carbon points. Admin-only access is enforced by the
-- verifyAdmin middleware and the admin JWT userType claim.

create table if not exists public.carbon_cards (
  id uuid primary key default gen_random_uuid(),
  citizen_id uuid not null unique references public.citizens(id) on delete cascade,
  total_points integer not null default 0 check (total_points >= 0),
  redeemed_points integer not null default 0 check (redeemed_points >= 0),
  available_points integer generated always as (total_points - redeemed_points) stored,
  tier text not null default 'Bronze' check (tier in ('Bronze', 'Silver', 'Gold', 'Platinum')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint carbon_cards_redeemed_within_total check (redeemed_points <= total_points)
);

create index if not exists carbon_cards_total_points_idx
  on public.carbon_cards (total_points desc);

-- Create wallets for citizens that already exist. New signup flows can use
-- the same insert pattern, or a later trigger can automate this.
insert into public.carbon_cards (citizen_id)
select c.id
from public.citizens c
where not exists (
  select 1
  from public.carbon_cards cc
  where cc.citizen_id = c.id
);

-- Automatically create a wallet for every citizen registered after this
-- migration is applied.
create or replace function public.create_carbon_card_for_citizen()
returns trigger
language plpgsql
as $$
begin
  insert into public.carbon_cards (citizen_id)
  values (new.id)
  on conflict (citizen_id) do nothing;
  return new;
end;
$$;

drop trigger if exists citizens_create_carbon_card on public.citizens;
create trigger citizens_create_carbon_card
after insert on public.citizens
for each row
execute function public.create_carbon_card_for_citizen();

-- Optional database-level helper for keeping updated_at current.
create or replace function public.set_carbon_card_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists carbon_cards_set_updated_at on public.carbon_cards;
create trigger carbon_cards_set_updated_at
before update on public.carbon_cards
for each row
execute function public.set_carbon_card_updated_at();

-- The API uses the server's Supabase client and its existing auth model
-- (application JWTs), so do not add auth.uid()-based RLS policies here unless
-- Supabase Auth is also used for these users. Enable RLS only after adding
-- policies that match your deployment's authentication model.
