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
create table if not exists garages (
  id          bigint generated always as identity primary key,
  owner_id    bigint not null references accounts(id) on delete cascade,
  name        text not null,
  total_spots integer not null check (total_spots > 0),
  created_at  timestamptz not null default now()
);

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
create or replace view garage_availability as
select
  g.id,
  g.name,
  g.owner_id,
  g.total_spots,
  count(r.id) filter (where r.parked_until > now())                  as occupied,
  g.total_spots - count(r.id) filter (where r.parked_until > now())  as open_spots
from garages g
left join reservations r on r.garage_id = g.id
group by g.id;

-- Every car currently (legally) parked — powers the Tow Company portal.
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
