-- =====================================================================
--  Park Now — Supabase / PostgreSQL schema
--  Run this ONCE in the Supabase dashboard:  SQL Editor → paste → Run.
--  Safe to re-run: it uses "if not exists" / "or replace" throughout.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- One row per (username, role). Username-only login, no passwords.
create table if not exists accounts (
  id          bigint generated always as identity primary key,
  username    text not null,
  role        text not null check (role in ('user', 'owner', 'tow')),
  created_at  timestamptz not null default now(),
  unique (username, role)
);

-- A parking garage created by an owner.
--   Layout: `floors` levels, each with `rows` aisles (lettered A, B, C…) of
--   `slots_per_row` spots. total_spots is kept as the canonical count
--   (= floors * rows * slots_per_row) so the spot-assignment functions and views
--   below stay unchanged; the floor/row/letter/side layout is derived from these
--   dimensions in the UI (spot label e.g. A203 = row A, floor 2, spot 03).
--   Older rows may have NULL floors/rows/slots_per_row — the simulation falls
--   back to a flat grid (and a single floor) for those.
create table if not exists garages (
  id            bigint generated always as identity primary key,
  owner_id      bigint not null references accounts(id) on delete cascade,
  name          text not null,
  total_spots   integer not null check (total_spots > 0),
  floors        integer check (floors is null or floors > 0),
  rows          integer check (rows is null or rows > 0),
  slots_per_row integer check (slots_per_row is null or slots_per_row > 0),
  created_at    timestamptz not null default now()
);

-- Upgrade databases created before these layout columns existed (safe to re-run).
alter table garages add column if not exists floors        integer;
alter table garages add column if not exists rows          integer;
alter table garages add column if not exists slots_per_row integer;

-- Keep total_spots in lock-step with the floor/row/slot layout. total_spots is the
-- canonical count every function/view reads; the map (js/garageMap.js) derives its
-- geometry from the dimensions. Enforcing the equality here means the two can never
-- disagree — no matter whether a row is created by the app, hand-edited in the table
-- editor, or backfilled. (Legacy flat lots with NULL dimensions are left as-is: they
-- keep their user-supplied total_spots and render as a single-floor grid.)
create or replace function garages_sync_total_spots()
returns trigger
language plpgsql
as $$
begin
  if new.floors is not null and new.rows is not null and new.slots_per_row is not null then
    new.total_spots := new.floors * new.rows * new.slots_per_row;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_garages_sync_total_spots on garages;
create trigger trg_garages_sync_total_spots
  before insert or update on garages
  for each row execute function garages_sync_total_spots();

-- One-time repair of any pre-trigger rows whose stored total_spots drifted from their
-- layout (e.g. a legacy flat lot that later had floors/rows/slots attached). Without
-- this, simulate_fill / the availability counts only cover the first floors.
update garages
   set total_spots = floors * rows * slots_per_row
 where floors is not null and rows is not null and slots_per_row is not null
   and total_spots <> floors * rows * slots_per_row;

-- A car registered by a user.
create table if not exists cars (
  id            bigint generated always as identity primary key,
  user_id       bigint not null references accounts(id) on delete cascade,
  make          text not null,
  model         text not null,
  color         text not null,
  license_plate text not null,
  size          text not null default 'normal' check (size in ('compact','normal','large')),
  is_ev         boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Upgrade databases created before the car size/EV columns existed (safe to re-run).
-- The inline check lives in the "add column" so it's idempotent (no separate
-- "add constraint if not exists" needed); existing rows backfill to the defaults.
alter table cars add column if not exists size text not null default 'normal'
  check (size in ('compact','normal','large'));
alter table cars add column if not exists is_ev boolean not null default false;

-- An active/expired parking reservation. A reservation is "active" while
-- parked_until > now(); expired ones are simply ignored (no cleanup job).
create table if not exists reservations (
  id           bigint generated always as identity primary key,
  garage_id    bigint not null references garages(id) on delete cascade,
  car_id       bigint not null references cars(id) on delete cascade,
  spot_number  integer not null,
  parked_at    timestamptz not null default now(),
  parked_until timestamptz not null,
  is_simulated boolean not null default false
);

create index if not exists idx_reservations_active
  on reservations (garage_id, parked_until);

-- The "simulator" account owns the fake cars created by the Simulate button,
-- so the tow-company list is a single uniform join (real + fake look the same).
insert into accounts (username, role)
values ('simulator', 'user')
on conflict (username, role) do nothing;

-- ---------------------------------------------------------------------
-- Views  (read directly from the browser via the Supabase client)
-- ---------------------------------------------------------------------

-- Live open/occupied counts per garage.
-- Dropped first: "create or replace view" can only APPEND columns, so it errors
-- if a new column (e.g. floors) is inserted mid-list. Dropping lets us define the
-- column order freely on every re-run. (Nothing depends on these views; the
-- grants at the bottom re-apply afterwards.)
drop view if exists garage_availability;
create or replace view garage_availability as
select
  g.id,
  g.name,
  g.owner_id,
  g.total_spots,
  g.floors,
  g.rows,
  g.slots_per_row,
  count(r.id) filter (where r.parked_until > now())                  as occupied,
  g.total_spots - count(r.id) filter (where r.parked_until > now())  as open_spots
from garages g
left join reservations r on r.garage_id = g.id
group by g.id;

-- Every car currently (legally) parked — powers the Tow Company portal.
drop view if exists currently_parked;
create or replace view currently_parked as
select
  r.id,
  r.garage_id,
  g.name as garage_name,
  r.spot_number,
  r.parked_at,
  r.parked_until,
  r.is_simulated,
  c.make,
  c.model,
  c.color,
  c.size,
  c.is_ev,
  c.license_plate
from reservations r
join garages g on g.id = r.garage_id
join cars    c on c.id = r.car_id
where r.parked_until > now();

-- ---------------------------------------------------------------------
-- Functions  (called from the browser via supabase.rpc(...))
--   security definer => they run with full rights so the spot-assignment
--   logic is correct and atomic regardless of row-level security.
-- ---------------------------------------------------------------------

-- Park a car in the lowest-numbered free spot of a garage.
-- Returns the assigned spot + expiry, or raises 'No spots available'.
create or replace function park_car(
  p_garage_id bigint,
  p_car_id    bigint,
  p_hours     numeric
)
returns table (spot_number integer, parked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_spot  integer;
  v_until timestamptz;
begin
  -- Lock the garage row so two users can't grab the same spot at once.
  select total_spots into v_total
  from garages
  where id = p_garage_id
  for update;

  if v_total is null then
    raise exception 'Garage not found';
  end if;

  -- A car can only occupy one spot at a time (anywhere). Block a second park
  -- while it still has an active reservation.
  if exists (
    select 1 from reservations r
    where r.car_id = p_car_id
      and r.parked_until > now()
  ) then
    raise exception 'This car is already parked';
  end if;

  -- Lowest spot number in 1..total that has no active reservation.
  select s.n into v_spot
  from generate_series(1, v_total) as s(n)
  where not exists (
    select 1 from reservations r
    where r.garage_id = p_garage_id
      and r.spot_number = s.n
      and r.parked_until > now()
  )
  order by s.n
  limit 1;

  if v_spot is null then
    raise exception 'No spots available';
  end if;

  v_until := now() + make_interval(mins => round(p_hours * 60)::int);

  insert into reservations (garage_id, car_id, spot_number, parked_until)
  values (p_garage_id, p_car_id, v_spot, v_until);

  spot_number  := v_spot;
  parked_until := v_until;
  return next;
end;
$$;

-- Fill up to p_count open spots (or ALL remaining if null) with random
-- fake cars under the simulator account. Returns how many it parked.
create or replace function simulate_fill(
  p_garage_id bigint,
  p_count     integer default null,
  p_hours     numeric default 2
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total   integer;
  v_sim     bigint;
  v_until   timestamptz;
  v_spot    integer;
  v_car     bigint;
  v_filled  integer := 0;
  v_plate   text;
  makes  text[] := array['Toyota','Honda','Ford','Tesla','BMW','Kia','Mazda','Subaru','Nissan','Jeep'];
  models text[] := array['Sedan','Coupe','SUV','Hatchback','Truck','Van','Wagon'];
  colors text[] := array['Black','White','Red','Blue','Silver','Green','Gray'];
  sizes  text[] := array['compact','normal','large'];
  ltrs   text   := 'ABCDEFGHJKLMNPRSTUVWXYZ';
begin
  select total_spots into v_total from garages where id = p_garage_id for update;
  if v_total is null then
    raise exception 'Garage not found';
  end if;

  select id into v_sim from accounts where username = 'simulator' and role = 'user';
  v_until := now() + make_interval(mins => round(p_hours * 60)::int);

  loop
    exit when p_count is not null and v_filled >= p_count;

    select s.n into v_spot
    from generate_series(1, v_total) as s(n)
    where not exists (
      select 1 from reservations r
      where r.garage_id = p_garage_id
        and r.spot_number = s.n
        and r.parked_until > now()
    )
    order by s.n
    limit 1;

    exit when v_spot is null;  -- garage is full

    v_plate := substr(ltrs, 1 + floor(random() * length(ltrs))::int, 1)
            || substr(ltrs, 1 + floor(random() * length(ltrs))::int, 1)
            || '-'
            || lpad((floor(random() * 10000))::int::text, 4, '0');

    insert into cars (user_id, make, model, color, license_plate, size, is_ev)
    values (
      v_sim,
      makes [1 + floor(random() * array_length(makes, 1))::int],
      models[1 + floor(random() * array_length(models, 1))::int],
      colors[1 + floor(random() * array_length(colors, 1))::int],
      v_plate,
      sizes[1 + floor(random() * array_length(sizes, 1))::int],
      random() < 0.2
    )
    returning id into v_car;

    insert into reservations (garage_id, car_id, spot_number, parked_until, is_simulated)
    values (p_garage_id, v_car, v_spot, v_until, true);

    v_filled := v_filled + 1;
  end loop;

  return v_filled;
end;
$$;

-- ---------------------------------------------------------------------
-- Row Level Security
--   PERMISSIVE policies for the MVP: anyone using the site can read/write.
--   This is intentional for a class demo. Tighten before going public.
-- ---------------------------------------------------------------------

alter table accounts     enable row level security;
alter table garages      enable row level security;
alter table cars         enable row level security;
alter table reservations enable row level security;

drop policy if exists "mvp all access" on accounts;
drop policy if exists "mvp all access" on garages;
drop policy if exists "mvp all access" on cars;
drop policy if exists "mvp all access" on reservations;

create policy "mvp all access" on accounts     for all using (true) with check (true);
create policy "mvp all access" on garages      for all using (true) with check (true);
create policy "mvp all access" on cars         for all using (true) with check (true);
create policy "mvp all access" on reservations for all using (true) with check (true);

-- Make sure the browser (anon) and logged-in (authenticated) roles can use
-- the tables, views, and functions through the auto-generated API.
grant usage on schema public to anon, authenticated;
grant all on accounts, garages, cars, reservations to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
grant select on garage_availability, currently_parked to anon, authenticated;
grant execute on function park_car(bigint, bigint, numeric)        to anon, authenticated;
grant execute on function simulate_fill(bigint, integer, numeric)  to anon, authenticated;

-- Done. Check the Table Editor — you should see 4 tables, 2 views, 2 functions.
