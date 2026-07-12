-- =====================================================================
--  Park Now — Supabase / PostgreSQL schema
--  Run this ONCE in the Supabase dashboard:  SQL Editor → paste → Run.
--  Safe to re-run: it uses "if not exists" / "or replace" throughout.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------
create extension if not exists pgcrypto;

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

-- Upgrade databases created before these existed
alter table accounts add column if not exists password_hash text;

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

-- A car registered by a user.
create table if not exists cars (
  id            bigint generated always as identity primary key,
  user_id       bigint not null references accounts(id) on delete cascade,
  make          text not null,
  model         text not null,
  color         text not null,
  license_plate text not null,
  created_at    timestamptz not null default now()
);

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


-- Create a new account with a hashed password. Returns {id, username, role}
-- as JSON - the hash itself never leaves the database.
create or replace function signup(p_username text, p_password text, p_role text)
returns JSON
language plpgsql
security definer
set search_path = public
as $$
declare
  acct accounts;
begin
  p_username := trim(p_username);
  if p_username is null or p_username = '' then 
    raise exception 'Please enter a username.';
  end if;
  if p_password is null or length(p_password) < 4 then 
    raise exception 'Password must be at least 4 characters.';
  end if;
  if p_role not in ('user', 'owner', 'tow') then 
    raise exception 'Invalid role.';
  end if;

  insert into accounts (username, role, password_hash)
  values (p_username, p_role, crypt(p_password, gen_salt('bf')))
  returning * into acct;

  return json_build_object('id', acct.id, 'username', acct.username, 'role', acct.role);
  exception 
  when unique_violation then 
    raise exception 'That username is already taken for the % role.', p_role;
  end;
  $$;

-- Verify {username, password, role} against the stored hash.
create or replace function login(p_username text, p_password text, p_role text) 
returns json
language plpgsql
security definer
set search_path = public
as $$ 
declare 
  acct accounts;
begin 
  select * into acct from accounts a 
    where a.username = trim(p_username) and a.role = p_role;

  if acct.id is null or acct.password_hash is null 
    or acct.password_hash <> crypt(p_password, acct.password_hash) then
    raise exception 'Incorrect username or pasword.';
  end if;

  return json_build_object('id', acct.id, 'username', acct.username, 'role', acct.role);
end;
$$;


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

    insert into cars (user_id, make, model, color, license_plate)
    values (
      v_sim,
      makes [1 + floor(random() * array_length(makes, 1))::int],
      models[1 + floor(random() * array_length(models, 1))::int],
      colors[1 + floor(random() * array_length(colors, 1))::int],
      v_plate
    )
    returning id into v_car;

    insert into reservations (garage_id, car_id, spot_number, parked_until, is_simulated)
    values (p_garage_id, v_car, v_spot, v_until, true);

    v_filled := v_filled + 1;
  end loop;

  return v_filled;
end;
$$;

-- Time-segmented future reservation engine
create or replace function reserve_car(
  p_garage_id bigint,
  p_car_id    bigint,
  p_start     timestamptz,
  p_hours     numeric
)
returns table (spot_number integer, parked_at timestamptz, parked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_spot  integer;
  v_end   timestamptz;
begin
  if p_start < now() - interval '5 minutes' then
    raise exception 'Cannot book a reservation in the past';
  end if;

  v_end := p_start + make_interval(mins => round(p_hours * 60)::int);

  select total_spots into v_total from garages where id = p_garage_id for update;

  if v_total is null then
    raise exception 'Garage not found';
  end if;

  if exists (
    select 1 from reservations r
    where r.car_id = p_car_id
      and r.parked_at < v_end 
      and r.parked_until > p_start
  ) then
    raise exception 'This car already has a reservation during this time window';
  end if;

  select s.n into v_spot
  from generate_series(1, v_total) as s(n)
  where not exists (
    select 1 from reservations r
    where r.garage_id = p_garage_id
      and r.spot_number = s.n
      and r.parked_at < v_end        
      and r.parked_until > p_start   
  )
  order by s.n
  limit 1;

  if v_spot is null then
    raise exception 'No spots available for this time window';
  end if;

  insert into reservations (garage_id, car_id, spot_number, parked_at, parked_until)
  values (p_garage_id, p_car_id, v_spot, p_start, v_end);

  spot_number  := v_spot;
  parked_at    := p_start;
  parked_until := v_end;
  return next;
end;
$$;

-- CANCEL FUTURE RESERVATION
create or replace function cancel_reservation(p_reservation_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Prevent canceling a reservation that has already started or finished
  if exists (
    select 1 from reservations 
    where id = p_reservation_id and parked_at <= now()
  ) then
    raise exception 'Cannot cancel an active or past reservation';
  end if;

  delete from reservations where id = p_reservation_id;
  return true;
end;
$$;

-- EXTEND CURRENT ACTIVE RESERVATION
create or replace function extend_current_reservation(
  p_reservation_id bigint,
  p_extra_hours    numeric
)
returns table (spot_number integer, parked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_garage_id bigint;
  v_target_spot integer;
  v_current_end timestamptz;
  v_new_end     timestamptz;
begin
  -- FIXED: Explicitly alias 'res.spot_number' to bypass the output parameter name conflict
  select res.garage_id, res.spot_number, res.parked_until 
    into v_garage_id, v_target_spot, v_current_end
  from reservations res 
  where res.id = p_reservation_id;

  if v_current_end is null then raise exception 'Reservation not found'; end if;
  if v_current_end < now() then raise exception 'Reservation has already expired'; end if;

  v_new_end := v_current_end + make_interval(mins => round(p_extra_hours * 60)::int);

  -- Check if another future booking already claimed this spot during the extension window
  if exists (
    select 1 from reservations r
    where r.garage_id = v_garage_id
      and r.spot_number = v_target_spot 
      and r.id != p_reservation_id
      and r.parked_at < v_new_end
      and r.parked_until > v_current_end
  ) then
    raise exception 'Cannot extend: Spot is reserved by another user during that extension window';
  end if;

  update reservations 
  set parked_until = v_new_end 
  where id = p_reservation_id;

  -- Assign return values explicitly
  spot_number := v_target_spot;
  parked_until := v_new_end;
  return next;
end;
$$;

-- ---------------------------------------------------------------------
-- EDIT FUTURE RESERVATION TIMING / DURATION
-- ---------------------------------------------------------------------
create or replace function edit_future_reservation(
  p_reservation_id bigint,
  p_new_start      timestamptz,
  p_new_hours      numeric
)
returns table (spot_number integer, parked_at timestamptz, parked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_garage_id bigint;
  v_car_id    bigint;
  v_target_spot integer;
  v_end       timestamptz;
begin
  if p_new_start < now() - interval '5 minutes' then
    raise exception 'Cannot shift reservation into the past';
  end if;

  -- FIXED: Explicitly alias 'res.spot_number' to bypass the output parameter name conflict
  select res.garage_id, res.car_id, res.spot_number 
    into v_garage_id, v_car_id, v_target_spot
  from reservations res 
  where res.id = p_reservation_id;

  if v_target_spot is null then raise exception 'Reservation not found'; end if;

  v_end := p_new_start + make_interval(mins => round(p_new_hours * 60)::int);

  -- Verify car doesn't conflict with another booking elsewhere
  if exists (
    select 1 from reservations r
    where r.car_id = v_car_id
      and r.id != p_reservation_id
      and r.parked_at < v_end 
      and r.parked_until > p_new_start
  ) then
    raise exception 'This car already has an overlapping booking during that timeframe';
  end if;

  -- Strategy: Check if the CURRENT spot is free during the new timeframe
  if not exists (
    select 1 from reservations r
    where r.garage_id = v_garage_id
      and r.spot_number = v_target_spot
      and r.id != p_reservation_id
      and r.parked_at < v_end
      and r.parked_until > p_new_start
  ) then
    -- Great! Keep current spot number
  else
    -- Current spot is blocked! Dynamically look for any alternative spot in the garage
    select s.n into v_target_spot
    from generate_series(1, (select total_spots from garages where id = v_garage_id)) as s(n)
    where not exists (
      select 1 from reservations r
      where r.garage_id = v_garage_id
        and r.spot_number = s.n
        and r.id != p_reservation_id
        and r.parked_at < v_end        
        and r.parked_until > p_new_start   
    )
    order by s.n limit 1;
  end if;

  if v_target_spot is null then
    raise exception 'No spots available anywhere in the garage for this new timeframe';
  end if;

  update reservations 
  set spot_number = v_target_spot, parked_at = p_new_start, parked_until = v_end 
  where id = p_reservation_id;

  -- Assign return values explicitly
  spot_number := v_target_spot;
  parked_at := p_new_start;
  parked_until := v_end;
  return next;
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
grant execute on function reserve_car(bigint, bigint, timestamptz, numeric) to anon, authenticated;
grant execute on function cancel_reservation(bigint) to anon, authenticated;
grant execute on function extend_current_reservation(bigint, numeric) to anon, authenticated;
grant execute on function edit_future_reservation(bigint, timestamptz, numeric) to anon, authenticated;

-- Hard clear cache to initialize endpoints immediately
NOTIFY pgrst, 'reload schema';
