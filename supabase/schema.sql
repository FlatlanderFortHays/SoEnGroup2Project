-- =====================================================================
--  Park Now — Supabase / PostgreSQL schema
--  Run this ONCE in the Supabase dashboard:  SQL Editor → paste → Run.
--  Safe to re-run: it uses "if not exists" / "or replace" throughout.
--
--  ####################################################################
--  ##  ⚠️  DESTRUCTIVE MIGRATION — READ THIS BEFORE YOU RUN IT  ⚠️   ##
--  ####################################################################
--  Logging in now REQUIRES a password. Any account created before
--  passwords existed has none, and can never log in again.
--
--  Rather than leave a half-migrated database, this file WIPES ALL APP
--  DATA (accounts, garages, cars, reservations) if it finds even ONE
--  such account. See "Legacy-account reset" further down.
--
--  => Running this against a database that still holds pre-password
--     accounts DELETES EVERY USER'S DATA in it. Warn the team first.
--     Everyone simply signs up again afterwards.
--  ####################################################################
-- =====================================================================

-- ---------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------
-- pgcrypto provides crypt() / gen_salt() — the bcrypt hashing used below.
-- NOTE: on Supabase pgcrypto usually already exists in the `extensions`
-- schema, which makes this line a no-op. That is why every auth function
-- below sets `search_path = public, extensions` and NOT just `public` —
-- with only `public` it would fail with "function crypt(text,text) does
-- not exist".
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- One row per (username, role). Passwords are bcrypt-hashed by signup().
create table if not exists accounts (
  id          bigint generated always as identity primary key,
  username    text not null,
  role        text not null check (role in ('user', 'owner', 'tow')),
  created_at  timestamptz not null default now(),
  unique (username, role)
);

-- Upgrade databases created before passwords existed (safe to re-run).
-- Deliberately NULLable: the seeded 'simulator' account never logs in, so it
-- legitimately has no password.
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

-- Pricing (UC13): each owner sets their own rate card. The defaults price every
-- pre-existing garage without the owner having to touch anything.
--   first hour        -> first_hour_rate  (charged in full, even for a partial hour)
--   every hour after  -> hourly_rate      (pro-rated by the minute)
--   per 24h period    -> daily_cap        (0 means "no cap")
alter table garages add column if not exists first_hour_rate numeric(10,2) not null default 5.00
  check (first_hour_rate >= 0);
alter table garages add column if not exists hourly_rate     numeric(10,2) not null default 3.00
  check (hourly_rate >= 0);
alter table garages add column if not exists daily_cap       numeric(10,2) not null default 25.00
  check (daily_cap >= 0);

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

-- Pricing. `price` is what the driver owes for this stay, in dollars.
--
-- The rate_* columns are a SNAPSHOT of the garage's rate card at the moment the
-- booking was made. They exist because the price has to stay locked in: Extend and
-- Edit re-price the WHOLE window (that's the only way the daily cap can't be dodged
-- by extending in small steps), and without a snapshot an owner raising their rates
-- would retroactively reprice hours the driver had already booked.
--
-- Nullable on purpose: a NOT NULL on a table with existing rows needs a default, and
-- a `default 0` would let a future RPC that forgets to set the price fail *silently*
-- at $0.00. The backfill below fills them in; the UI null-guards anyway.
alter table reservations add column if not exists price           numeric(10,2);
alter table reservations add column if not exists rate_first_hour numeric(10,2);
alter table reservations add column if not exists rate_hourly     numeric(10,2);
alter table reservations add column if not exists rate_daily_cap  numeric(10,2);

-- A poisoned snapshot (e.g. a negative rate written straight through the anon key)
-- would make every future Extend/Edit on that row fail forever. Reject it up front.
alter table reservations drop constraint if exists reservations_rates_check;
alter table reservations add  constraint reservations_rates_check check (
  (rate_first_hour is null or rate_first_hour >= 0) and
  (rate_hourly     is null or rate_hourly     >= 0) and
  (rate_daily_cap  is null or rate_daily_cap  >= 0) and
  (price           is null or price           >= 0)
);

-- ---------------------------------------------------------------------
-- Legacy-account reset   ⚠️ DESTRUCTIVE — WIPES ALL APP DATA
--
--   Passwords are mandatory now, so an account with a NULL password_hash is
--   a dead account: nobody can ever log into it. Instead of leaving the
--   database half-migrated, we start clean — if even ONE such account exists,
--   every row of app data is deleted and everyone signs up again.
--
--   The seeded 'simulator' account is EXCLUDED from the check. It is a system
--   account that owns the fake "Simulate fill" cars and never logs in, so it
--   has no password by design. Excluding it is also what stops this block
--   firing on every run: the seed below re-creates it after each wipe, and if
--   it counted, the very next run would wipe the database again, forever.
--
--   `truncate ... restart identity cascade` is the "delete everything and
--   start fresh" step: every row goes and ids reset to 1 — but the TABLES
--   themselves survive, so columns teammates added via `alter table ... add
--   column` (price, rates, password_hash …) aren't lost and this file stays
--   re-runnable.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
      from accounts
     where password_hash is null
       and not (username = 'simulator' and role = 'user')
  ) then
    raise notice '################################################################';
    raise notice '## Park Now: found account(s) with no password (pre-password). ';
    raise notice '## WIPING ALL APP DATA — accounts, garages, cars, reservations. ';
    raise notice '## Everyone must sign up again.                                 ';
    raise notice '################################################################';
    truncate reservations, cars, garages, accounts restart identity cascade;
  end if;
end;
$$;

-- The "simulator" account owns the fake cars created by the Simulate button,
-- so the tow-company list is a single uniform join (real + fake look the same).
insert into accounts (username, role)
values ('simulator', 'user')
on conflict (username, role) do nothing;

-- ---------------------------------------------------------------------
-- Pricing engine  (UC06 calculateCost / UC13 base rates)
--
-- THE FORMULA — mirrored line-for-line in js/price.js. If you change one,
-- change the other, and re-run price_selftest() + Pricing.selfTest().
--
--   The billable unit is the INTEGER MINUTE, because that is literally what the
--   booking functions sell: they all do make_interval(mins => round(p_hours*60)).
--   Pricing raw float hours instead would let the quote disagree with the window
--   the driver actually gets. All arithmetic is in INTEGER CENTS.
--
--   period 0  = the first min(M, 1440) minutes
--               -> min( first_hour + hourly * max(0, min(M,1440) - 60)/60 , cap )
--   period k  = each following 24h block (or the trailing partial one)
--               -> min( hourly * (minutes in block)/60 , cap )
--   total     = sum of all periods
--
--   The first-hour premium is charged ONCE PER STAY, not once per day: charging it
--   per day would put a $5 cliff at exactly 24h (24.0h = $25 -> 24.1h = $30), which
--   is the same "price jumps off a cliff at a boundary" defect the tiered draft had.
--   The cap applies to each 24h period independently, so a 48h stay costs 2x the cap.
--   A cap of 0 means "no cap".
--
--   At the default $5 / $3 / $25:
--     30min $5.00 · 1h $5.00 · 2h $8.00 · 2.1h $8.30 · 2.5h $9.50 · 5h $17.00
--     5.5h $18.50 · 8h $25.00 (capped) · 24h $25.00 · 24.1h $25.30 · 25h $28.00
--     30h $43.00 · 48h $50.00
-- ---------------------------------------------------------------------

-- Pure: rates in, price out. The booking functions call it with the reservation's
-- SNAPSHOT rates, which is why it can't just read the garage row itself.
-- (drop first: widening a parameter later would otherwise silently mint a second
--  overload, and PostgREST would start returning PGRST203 instead of a price.)
drop function if exists calculate_price_rates(numeric, numeric, numeric, integer);
create function calculate_price_rates(
  p_first_hour numeric,
  p_hourly     numeric,
  p_daily_cap  numeric,
  p_minutes    integer
)
returns numeric
language plpgsql
immutable
as $$
declare
  v_first_c  bigint  := round(coalesce(p_first_hour, 0) * 100);
  v_hourly_c bigint  := round(coalesce(p_hourly,     0) * 100);
  v_cap_c    bigint  := round(coalesce(p_daily_cap,  0) * 100);
  v_capped   boolean := v_cap_c > 0;   -- 0 = no cap
  v_full     integer;                  -- whole 24h periods in the stay
  v_rem      integer;                  -- leftover minutes after them
  v_total    bigint;
begin
  if p_minutes is null or p_minutes <= 0 then
    return 0.00;
  end if;

  v_full := p_minutes / 1440;   -- integer division
  v_rem  := p_minutes % 1440;

  -- Period 0 carries the once-per-stay first-hour premium.
  v_total := v_first_c
           + round((v_hourly_c::numeric * greatest(0, least(p_minutes, 1440) - 60)) / 60);
  if v_capped then
    v_total := least(v_total, v_cap_c);
  end if;

  if v_full > 0 then
    -- The full 24h periods that follow period 0 (there are v_full - 1 of them).
    v_total := v_total + (v_full - 1) * (
      case when v_capped then least(v_hourly_c * 24, v_cap_c)
           else v_hourly_c * 24 end
    );
    -- ...and the trailing partial period.
    if v_rem > 0 then
      v_total := v_total + (
        case when v_capped then least(round((v_hourly_c::numeric * v_rem) / 60), v_cap_c)
             else round((v_hourly_c::numeric * v_rem) / 60) end
      );
    end if;
  end if;

  return v_total::numeric / 100;
end;
$$;

-- UC06's calculateCost(...): price p_hours at a garage's CURRENT rate card.
drop function if exists calculate_price(bigint, numeric);
create function calculate_price(p_garage_id bigint, p_hours numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select calculate_price_rates(g.first_hour_rate, g.hourly_rate, g.daily_cap,
                               round(p_hours * 60)::int)
  from garages g
  where g.id = p_garage_id;
$$;

-- Golden vectors. js/price.js asserts the same list on load (Pricing.selfTest()),
-- so the two implementations can't drift apart unnoticed.
--   select * from price_selftest();   -- every row must be ok = true
drop function if exists price_selftest();
create function price_selftest()
returns table (minutes integer, expected numeric, actual numeric, ok boolean)
language sql
immutable
as $$
  select v.m, v.want, calculate_price_rates(5, 3, 25, v.m),
         calculate_price_rates(5, 3, 25, v.m) = v.want
  from (values
    (0, 0.00), (30, 5.00), (60, 5.00), (61, 5.05), (120, 8.00), (126, 8.30),
    (150, 9.50), (300, 17.00), (330, 18.50), (460, 25.00), (480, 25.00),
    (1440, 25.00), (1441, 25.05), (1446, 25.30), (1500, 28.00), (1800, 43.00),
    (2880, 50.00), (2881, 50.05), (2886, 50.30)
  ) as v(m, want);
$$;

-- Backfill: give every pre-existing reservation the rate card its garage carries
-- today, then price it from its own window length. Runs once; the `is null` guards
-- make a re-run a no-op (and stop it from overwriting a real booked-in price).
update reservations r
   set rate_first_hour = coalesce(r.rate_first_hour, g.first_hour_rate),
       rate_hourly     = coalesce(r.rate_hourly,     g.hourly_rate),
       rate_daily_cap  = coalesce(r.rate_daily_cap,  g.daily_cap)
  from garages g
 where g.id = r.garage_id
   and (r.rate_first_hour is null or r.rate_hourly is null or r.rate_daily_cap is null);

update reservations r
   set price = calculate_price_rates(
                 r.rate_first_hour, r.rate_hourly, r.rate_daily_cap,
                 round(extract(epoch from (r.parked_until - r.parked_at)) / 60)::int)
 where r.price is null;

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
  g.first_hour_rate,
  g.hourly_rate,
  g.daily_cap,
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
-- Returns the assigned spot + expiry + price, or raises 'No spots available'.
--
-- NOTE the `drop function` — this and the three below gained a `price` column in
-- their return type. Postgres will NOT let "create or replace" change a return type
-- ("42P13: cannot change return type of existing function"), so re-running this file
-- against an older database fails at exactly this line without the drop.
drop function if exists park_car(bigint, bigint, numeric);
create function park_car(
  p_garage_id bigint,
  p_car_id    bigint,
  p_hours     numeric
)
returns table (spot_number integer, parked_until timestamptz, price numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total  integer;
  v_spot   integer;
  v_until  timestamptz;
  v_mins   integer;
  v_first  numeric;
  v_hourly numeric;
  v_cap    numeric;
  v_price  numeric;
begin
  -- Lock the garage row so two users can't grab the same spot at once.
  -- (The rate card is read under the same lock, so the price can't be computed from
  --  a rate the owner is editing at this instant.)
  select total_spots, first_hour_rate, hourly_rate, daily_cap
    into v_total, v_first, v_hourly, v_cap
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

  -- Minutes are computed ONCE and drive both the window and the price, so the
  -- amount charged always matches the window the driver actually got.
  v_mins  := round(p_hours * 60)::int;
  v_until := now() + make_interval(mins => v_mins);
  v_price := calculate_price_rates(v_first, v_hourly, v_cap, v_mins);

  insert into reservations (garage_id, car_id, spot_number, parked_until,
                            price, rate_first_hour, rate_hourly, rate_daily_cap)
  values (p_garage_id, p_car_id, v_spot, v_until,
          v_price, v_first, v_hourly, v_cap);

  spot_number  := v_spot;
  parked_until := v_until;
  price        := v_price;
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
  v_mins    integer;
  v_first   numeric;
  v_hourly  numeric;
  v_cap     numeric;
  v_price   numeric;
  makes  text[] := array['Toyota','Honda','Ford','Tesla','BMW','Kia','Mazda','Subaru','Nissan','Jeep'];
  models text[] := array['Sedan','Coupe','SUV','Hatchback','Truck','Van','Wagon'];
  colors text[] := array['Black','White','Red','Blue','Silver','Green','Gray'];
  sizes  text[] := array['compact','normal','large'];
  ltrs   text   := 'ABCDEFGHJKLMNPRSTUVWXYZ';
begin
  select total_spots, first_hour_rate, hourly_rate, daily_cap
    into v_total, v_first, v_hourly, v_cap
  from garages where id = p_garage_id for update;
  if v_total is null then
    raise exception 'Garage not found';
  end if;

  select id into v_sim from accounts where username = 'simulator' and role = 'user';

  -- Every simulated car shares the same p_hours, so price it once up front.
  v_mins  := round(p_hours * 60)::int;
  v_until := now() + make_interval(mins => v_mins);
  v_price := calculate_price_rates(v_first, v_hourly, v_cap, v_mins);

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

    insert into reservations (garage_id, car_id, spot_number, parked_until, is_simulated,
                              price, rate_first_hour, rate_hourly, rate_daily_cap)
    values (p_garage_id, v_car, v_spot, v_until, true,
            v_price, v_first, v_hourly, v_cap);

    v_filled := v_filled + 1;
  end loop;

  return v_filled;
end;
$$;

-- Time-segmented future reservation engine
drop function if exists reserve_car(bigint, bigint, timestamptz, numeric);
create function reserve_car(
  p_garage_id bigint,
  p_car_id    bigint,
  p_start     timestamptz,
  p_hours     numeric
)
returns table (spot_number integer, parked_at timestamptz, parked_until timestamptz, price numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total  integer;
  v_spot   integer;
  v_end    timestamptz;
  v_mins   integer;
  v_first  numeric;
  v_hourly numeric;
  v_cap    numeric;
  v_price  numeric;
begin
  if p_start < now() - interval '5 minutes' then
    raise exception 'Cannot book a reservation in the past';
  end if;

  v_mins := round(p_hours * 60)::int;
  v_end  := p_start + make_interval(mins => v_mins);

  select total_spots, first_hour_rate, hourly_rate, daily_cap
    into v_total, v_first, v_hourly, v_cap
  from garages where id = p_garage_id for update;

  if v_total is null then
    raise exception 'Garage not found';
  end if;

  v_price := calculate_price_rates(v_first, v_hourly, v_cap, v_mins);

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

  insert into reservations (garage_id, car_id, spot_number, parked_at, parked_until,
                            price, rate_first_hour, rate_hourly, rate_daily_cap)
  values (p_garage_id, p_car_id, v_spot, p_start, v_end,
          v_price, v_first, v_hourly, v_cap);

  spot_number  := v_spot;
  parked_at    := p_start;
  parked_until := v_end;
  price        := v_price;
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
--
-- Re-prices the ENTIRE new window, not just the added hours, and does it against the
-- rate card SNAPSHOTTED on the reservation when it was booked.
--
--   * Whole window, because the daily cap is a property of the stay. Charging only
--     for the added hours would let a driver walk straight past a "max $25/day" cap
--     by extending an hour at a time.
--   * Snapshot rates, because the driver agreed to a price at booking time. Re-pricing
--     at the garage's CURRENT rates would let an owner retroactively bill already-booked
--     hours at a new rate the moment the driver hits Extend.
drop function if exists extend_current_reservation(bigint, numeric);
create function extend_current_reservation(
  p_reservation_id bigint,
  p_extra_hours    numeric
)
returns table (spot_number integer, parked_until timestamptz, price numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_garage_id   bigint;
  v_target_spot integer;
  v_start       timestamptz;
  v_current_end timestamptz;
  v_new_end     timestamptz;
  v_first       numeric;
  v_hourly      numeric;
  v_cap         numeric;
  v_price       numeric;
begin
  -- FIXED: Explicitly alias 'res.spot_number' to bypass the output parameter name conflict
  select res.garage_id, res.spot_number, res.parked_at, res.parked_until,
         res.rate_first_hour, res.rate_hourly, res.rate_daily_cap
    into v_garage_id, v_target_spot, v_start, v_current_end,
         v_first, v_hourly, v_cap
  from reservations res
  where res.id = p_reservation_id;

  if v_current_end is null then raise exception 'Reservation not found'; end if;
  if v_current_end < now() then raise exception 'Reservation has already expired'; end if;

  -- Reservations booked before pricing existed carry no snapshot. Fall back to the
  -- garage's current rate card and write it back, so the row is priceable from now on.
  if v_first is null or v_hourly is null or v_cap is null then
    select first_hour_rate, hourly_rate, daily_cap
      into v_first, v_hourly, v_cap
    from garages where id = v_garage_id;
  end if;

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

  v_price := calculate_price_rates(
    v_first, v_hourly, v_cap,
    round(extract(epoch from (v_new_end - v_start)) / 60)::int
  );

  update reservations
  set parked_until    = v_new_end,
      price           = v_price,
      rate_first_hour = v_first,
      rate_hourly     = v_hourly,
      rate_daily_cap  = v_cap
  where id = p_reservation_id;

  -- Assign return values explicitly
  spot_number  := v_target_spot;
  parked_until := v_new_end;
  price        := v_price;
  return next;
end;
$$;

-- ---------------------------------------------------------------------
-- EDIT FUTURE RESERVATION TIMING / DURATION
-- ---------------------------------------------------------------------
drop function if exists edit_future_reservation(bigint, timestamptz, numeric);
create function edit_future_reservation(
  p_reservation_id bigint,
  p_new_start      timestamptz,
  p_new_hours      numeric
)
returns table (spot_number integer, parked_at timestamptz, parked_until timestamptz, price numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_garage_id bigint;
  v_car_id    bigint;
  v_target_spot integer;
  v_end       timestamptz;
  v_mins      integer;
  v_first     numeric;
  v_hourly    numeric;
  v_cap       numeric;
  v_price     numeric;
begin
  if p_new_start < now() - interval '5 minutes' then
    raise exception 'Cannot shift reservation into the past';
  end if;

  -- FIXED: Explicitly alias 'res.spot_number' to bypass the output parameter name conflict
  select res.garage_id, res.car_id, res.spot_number,
         res.rate_first_hour, res.rate_hourly, res.rate_daily_cap
    into v_garage_id, v_car_id, v_target_spot,
         v_first, v_hourly, v_cap
  from reservations res
  where res.id = p_reservation_id;

  if v_target_spot is null then raise exception 'Reservation not found'; end if;

  -- Pre-pricing reservations carry no snapshot; fall back to the garage's rate card.
  if v_first is null or v_hourly is null or v_cap is null then
    select first_hour_rate, hourly_rate, daily_cap
      into v_first, v_hourly, v_cap
    from garages where id = v_garage_id;
  end if;

  v_mins := round(p_new_hours * 60)::int;
  v_end  := p_new_start + make_interval(mins => v_mins);
  -- Re-price the new window at the rates the driver originally booked at.
  v_price := calculate_price_rates(v_first, v_hourly, v_cap, v_mins);

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
  set spot_number     = v_target_spot,
      parked_at       = p_new_start,
      parked_until    = v_end,
      price           = v_price,
      rate_first_hour = v_first,
      rate_hourly     = v_hourly,
      rate_daily_cap  = v_cap
  where id = p_reservation_id;

  -- Assign return values explicitly
  spot_number := v_target_spot;
  parked_at := p_new_start;
  parked_until := v_end;
  price := v_price;
  return next;
end;
$$;

-- ---------------------------------------------------------------------
-- Authentication  (signup / login)
--
--   The browser calls these two as RPCs (see js/supabaseClient.js `Auth`):
--       sb.rpc("signup", { p_username, p_password, p_role })
--       sb.rpc("login",  { p_username, p_password, p_role })
--
--   Passwords are bcrypt-hashed INSIDE Postgres by pgcrypto. The plaintext is
--   sent once over HTTPS and never stored; the browser never sees a hash. The
--   `accounts` table is revoked from anon at the bottom of this file, so these
--   two security-definer functions are the ONLY way in.
--
--   Both RAISE on failure, so supabase-js surfaces `error` and the frontend's
--   `if (error) throw new Error(error.message)` shows it to the user.
-- ---------------------------------------------------------------------

-- Dropped first so this file stays re-runnable if a signature or an OUT
-- parameter name ever changes ("create or replace" cannot change either).
drop function if exists signup(text, text, text);
drop function if exists login(text, text, text);

-- Create an account and return it. Raises if the (username, role) is taken.
create function signup(
  p_username text,
  p_password text,
  p_role     text
)
returns table (id bigint, username text, role text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_username text := btrim(coalesce(p_username, ''));
  v_id       bigint;
begin
  -- Re-check everything the browser already checked: this RPC is a PUBLIC
  -- endpoint, and curl doesn't run our JavaScript.
  if v_username = '' then
    raise exception 'Please enter a username.';
  end if;
  if p_password is null or length(p_password) < 4 then
    -- Not optional: crypt('', gen_salt(...)) is a perfectly valid hash which
    -- crypt('', hash) later matches — so an empty password would "work".
    raise exception 'Password must be at least 4 characters.';
  end if;
  if p_role is null or p_role not in ('user', 'owner', 'tow') then
    raise exception 'Unknown role.';
  end if;

  begin
    -- "as a" so RETURNING can be qualified: a bare "returning id" is ambiguous
    -- against the OUT parameter of the same name.
    insert into accounts as a (username, role, password_hash)
    values (v_username, p_role, crypt(p_password, gen_salt('bf', 10)))
    returning a.id into v_id;
  exception when unique_violation then
    raise exception 'That username is already taken for this role.';
  end;

  id       := v_id;
  username := v_username;
  role     := p_role;
  return next;
end;
$$;

-- Verify {username, password} against the stored bcrypt hash.
create function login(
  p_username text,
  p_password text,
  p_role     text
)
returns table (id bigint, username text, role text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_username text := btrim(coalesce(p_username, ''));
  v_id       bigint;
  v_hash     text;
begin
  -- Reject NULL/empty passwords BEFORE they reach crypt(). This guard is load
  -- bearing: crypt(NULL, hash) returns NULL, so the comparison further down
  -- would be NULL — neither true nor false — and `if <null> then raise` simply
  -- falls through and LOGS THE CALLER IN. PostgREST passes JSON null straight
  -- through as SQL NULL, so {"p_password": null} would be a real auth bypass.
  if v_username = '' or p_password is null or p_password = '' then
    raise exception 'Invalid username or password.';
  end if;

  select a.id, a.password_hash
    into v_id, v_hash
    from accounts a
   where a.username = v_username
     and a.role     = p_role;

  if v_id is null then
    -- Burn one bcrypt round so "no such user" costs the same as "wrong
    -- password". Without it, ~0ms vs ~80ms response times let anyone
    -- enumerate every valid username in the database.
    perform crypt(p_password, gen_salt('bf', 10));
    raise exception 'Invalid username or password.';
  end if;

  if v_hash is null then
    -- Pre-password account. The reset block near the top of this file normally
    -- removes these, so reaching here means the account was made some other way.
    raise exception 'This account has no password. Please sign up again.';
  end if;

  -- "is distinct from", not "<>": NULL-safe by construction.
  if v_hash is distinct from crypt(p_password, v_hash) then
    raise exception 'Invalid username or password.';
  end if;

  id       := v_id;
  username := v_username;
  role     := p_role;
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
-- NOTE: `accounts` is deliberately NOT in this list — it holds password hashes.
-- The browser reaches it only through signup()/login(). See the lockdown at the
-- very bottom of this file.
grant all on garages, cars, reservations to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
grant select on garage_availability, currently_parked to anon, authenticated;
grant execute on function calculate_price_rates(numeric, numeric, numeric, integer) to anon, authenticated;
grant execute on function calculate_price(bigint, numeric)         to anon, authenticated;
grant execute on function price_selftest()                         to anon, authenticated;
grant execute on function park_car(bigint, bigint, numeric)        to anon, authenticated;
grant execute on function simulate_fill(bigint, integer, numeric)  to anon, authenticated;
grant execute on function reserve_car(bigint, bigint, timestamptz, numeric) to anon, authenticated;
grant execute on function cancel_reservation(bigint) to anon, authenticated;
grant execute on function extend_current_reservation(bigint, numeric) to anon, authenticated;
grant execute on function edit_future_reservation(bigint, timestamptz, numeric) to anon, authenticated;
grant execute on function signup(text, text, text) to anon, authenticated;
grant execute on function login(text, text, text)  to anon, authenticated;

-- ---------------------------------------------------------------------
-- Lock down `accounts` (it stores password hashes)
--
--   MUST stay AFTER the grants above — this file is replayed top-to-bottom,
--   so a revoke placed earlier would just be re-granted.
--
--   Note a COLUMN-level "revoke select (password_hash) ... from anon" does NOT
--   work: the permission check is (table-level SELECT) OR (column-level
--   SELECT), so a table-level grant satisfies it for every column and the
--   column revoke is silently a no-op. The table privilege has to go entirely.
--
--   Nothing breaks, because:
--     * the browser never selects from `accounts` — all account access goes
--       through the signup()/login() RPCs above;
--     * signup/login/simulate_fill are SECURITY DEFINER, so they read and
--       write `accounts` as the function owner, not as anon;
--     * the garages.owner_id / cars.user_id foreign keys still validate — a
--       referential-integrity check runs as the owner of the REFERENCED table,
--       so the inserting role needs no privilege on `accounts` at all;
--     * neither view (garage_availability, currently_parked) touches accounts.
--
--   This is what stops anyone holding the PUBLIC anon key from simply reading
--   every password hash out of the table (or overwriting one to hijack an
--   account), which would make hashing them pointless.
-- ---------------------------------------------------------------------
revoke all on table accounts from anon, authenticated;

-- Hard clear cache to initialize endpoints immediately
NOTIFY pgrst, 'reload schema';
