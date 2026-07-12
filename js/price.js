// ---------------------------------------------------------------------
//  Pricing engine — the browser-side mirror of the SQL in supabase/schema.sql.
//
//  Based on the two pricing drafts by the pricing group:
//    * basicpricing.js — the shape kept here: pure functions, no side effects,
//      a getPricingSummary()-style object with a ready-made message.
//    * price.js — the instinct kept here: charge each hour at its OWN rate as it
//      passes, rather than re-charging every hour at the final bracket's rate.
//      That's what stops the price falling off a cliff at a tier boundary.
//
//  What changed from the drafts, and why:
//    1. The rate DIRECTION is inverted. Both drafts made a long stay cost MORE per
//       hour ($1 -> $3 -> $5). Real garages do the opposite. Now: a premium first
//       hour, cheaper after, capped per day.
//    2. Rates are no longer constants. Each garage carries its own rate card in the
//       DB (UC13), so every function here takes `rates` as a parameter.
//    3. No cliffs. basicpricing.js's calculatePrice() multiplied ALL hours by the
//       bracket rate, so 2.0h cost $2.00 but 2.1h cost $6.30 — and #park-hours is
//       step="0.1", so drivers hit that on their first try. Fixed.
//    4. No timer. price.js's setInterval fired on script load, for every visitor, on
//       every page, and one global counter couldn't price two bookings at once. The
//       app already stores real parked_at/parked_until timestamps; we price those.
//
//  THE DATABASE IS AUTHORITATIVE. The booking RPCs compute and store the price and
//  return it; every committed surface renders THAT number. Everything here is a live
//  PREVIEW (always labelled "Est."), so the user sees a cost before they click Book.
//
//  THE FORMULA (mirrored from calculate_price_rates() in supabase/schema.sql — if you
//  change one, change the other, then run Pricing.selfTest() and price_selftest()):
//
//    The billable unit is the INTEGER MINUTE, because that is what the DB actually
//    sells: every booking RPC does make_interval(mins => round(p_hours * 60)).
//    All arithmetic is in INTEGER CENTS. Those two choices are what let this file and
//    Postgres agree to the cent instead of drifting apart on float noise.
//
//      period 0  = the first min(M, 1440) minutes
//                  -> min( first_hour + hourly * max(0, min(M,1440) - 60)/60 , cap )
//      period k  = each following 24h block (and the trailing partial one)
//                  -> min( hourly * (minutes in block)/60 , cap )
//      total     = sum of all periods
//
//    The first-hour premium is charged ONCE PER STAY, not once per day — charging it
//    per day would put a $5 cliff at exactly 24h, which is the very defect we removed.
//    The cap applies to each 24h period independently (so 48h costs 2x the cap).
//    A cap of 0 means "no cap".
// ---------------------------------------------------------------------

(function () {
  const MINUTES_PER_DAY = 1440;

  // What a garage's rate card falls back to when the database predates pricing.
  // Keep in step with the column defaults in supabase/schema.sql.
  const DEFAULT_RATES = { first_hour_rate: 5, hourly_rate: 3, daily_cap: 25 };

  // Hours -> billable minutes, matching Postgres's round(p_hours * 60) EXACTLY.
  //
  // The .toFixed(6) is not decoration. Postgres parses the JSON number as an exact
  // decimal, so round(1.025 * 60) there is round(61.500) = 62. In JS, 1.025 * 60 is
  // 61.49999999999999, so a plain Math.round() gives 61 — the preview and the charge
  // would disagree. Rounding the float noise away first makes both say 62.
  function hoursToMinutes(hours) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) return 0;
    return Math.round(Number((h * 60).toFixed(6)));
  }

  function toCents(dollars) {
    const d = Number(dollars);
    if (!Number.isFinite(d) || d <= 0) return 0;
    return Math.round(Number((d * 100).toFixed(6)));
  }

  // Charge for `minutes` at `hourlyCents`/hr, pro-rated by the minute.
  // Math.round() over an exact-integer product reproduces Postgres's
  // round((hourly_c::numeric * mins) / 60) for every positive value: both round
  // halves away from zero, and a mathematical .5 here is exactly representable.
  function proRata(hourlyCents, minutes) {
    return Math.round((hourlyCents * minutes) / 60);
  }

  // Fill in any rate the row is missing (an un-migrated database returns none of them).
  function normalizeRates(row) {
    const r = row || {};
    const pick = (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
      first_hour_rate: pick(r.first_hour_rate, DEFAULT_RATES.first_hour_rate),
      hourly_rate:     pick(r.hourly_rate,     DEFAULT_RATES.hourly_rate),
      daily_cap:       pick(r.daily_cap,       DEFAULT_RATES.daily_cap),
    };
  }

  // True when a garage row actually carries the pricing columns — i.e. the database
  // has been migrated. Used to warn instead of silently showing made-up defaults.
  function hasRates(row) {
    return !!row && row.first_hour_rate != null && row.hourly_rate != null && row.daily_cap != null;
  }

  // The core. Mirrors calculate_price_rates(first, hourly, cap, minutes).
  function priceCents(rates, minutes) {
    const m = Math.trunc(Number(minutes));
    if (!Number.isFinite(m) || m <= 0) return 0;

    const { first_hour_rate, hourly_rate, daily_cap } = normalizeRates(rates);
    const firstC  = toCents(first_hour_rate);
    const hourlyC = toCents(hourly_rate);
    const capC    = toCents(daily_cap);
    const capped  = capC > 0;                       // 0 = no cap

    const fullDays = Math.floor(m / MINUTES_PER_DAY);
    const remainder = m % MINUTES_PER_DAY;

    // Period 0 carries the once-per-stay first-hour premium.
    let total = firstC + proRata(hourlyC, Math.max(0, Math.min(m, MINUTES_PER_DAY) - 60));
    if (capped) total = Math.min(total, capC);

    if (fullDays > 0) {
      // The full 24h periods that follow period 0 (there are fullDays - 1 of them).
      const fullDayCharge = capped ? Math.min(hourlyC * 24, capC) : hourlyC * 24;
      total += (fullDays - 1) * fullDayCharge;

      // ...and the trailing partial period.
      if (remainder > 0) {
        const tail = proRata(hourlyC, remainder);
        total += capped ? Math.min(tail, capC) : tail;
      }
    }
    return total;
  }

  function formatCents(cents) {
    return "$" + (cents / 100).toFixed(2);
  }

  // Null-safe money for a value already in dollars (e.g. reservations.price, which is
  // null on rows booked before pricing existed). Never renders "$null" or "$NaN".
  function money(dollars) {
    if (dollars == null) return "—";
    const n = Number(dollars);
    if (!Number.isFinite(n)) return "—";
    return "$" + n.toFixed(2);
  }

  // A whole quote for `hours` at a garage's `rates`. This is basicpricing.js's
  // getPricingSummary() — same idea, same ready-to-render `message`.
  function quote(rates, hours) {
    const r = normalizeRates(rates);
    const minutes = hoursToMinutes(hours);
    const cents = priceCents(r, minutes);

    // "capped" == the daily cap actually bit, i.e. the driver is paying less than the
    // raw hourly accrual. Worth surfacing: it's why extra hours can come out free.
    const uncappedC = priceCents({ ...r, daily_cap: 0 }, minutes);
    const capped = r.daily_cap > 0 && cents < uncappedC;

    return {
      hours: Number(hours) || 0,
      minutes,
      cents,
      dollars: cents / 100,
      formatted: formatCents(cents),
      capped,
      rates: r,
      message: minutes > 0
        ? `Estimated price for ${formatHours(minutes)}: ${formatCents(cents)}${capped ? " (daily cap applied)" : ""}.`
        : "Enter a number of hours to see a price.",
    };
  }

  // 90 -> "1h 30m", 120 -> "2h", 45 -> "45m"
  function formatHours(minutes) {
    const m = Math.max(0, Math.trunc(minutes));
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (h && rem) return `${h}h ${rem}m`;
    if (h) return `${h}h`;
    return `${rem}m`;
  }

  // A trim number for a rate: 5 -> "$5", 4.5 -> "$4.50"
  function rate(dollars) {
    const n = Number(dollars) || 0;
    return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
  }

  // "$5 first hr, then $3/hr, max $25/day"
  function rateCard(rates) {
    const r = normalizeRates(rates);
    const cap = r.daily_cap > 0 ? `, max ${rate(r.daily_cap)}/day` : "";
    return `${rate(r.first_hour_rate)} first hr, then ${rate(r.hourly_rate)}/hr${cap}`;
  }

  // ---- Self-test -------------------------------------------------------
  // The same golden vectors as price_selftest() in supabase/schema.sql. If the two
  // implementations ever drift, one of them starts failing this on page load.
  const GOLDEN = [
    [0, 0.00], [30, 5.00], [60, 5.00], [61, 5.05], [120, 8.00], [126, 8.30],
    [150, 9.50], [300, 17.00], [330, 18.50], [460, 25.00], [480, 25.00],
    [1440, 25.00], [1441, 25.05], [1446, 25.30], [1500, 28.00], [1800, 43.00],
    [2880, 50.00], [2881, 50.05], [2886, 50.30],
  ];

  // Hours -> minutes must match Postgres too, or the quote can disagree with the
  // window the driver is actually sold. 1.025 is the case a plain Math.round() fails.
  const GOLDEN_MINUTES = [
    [0.5, 30], [1, 60], [2, 120], [2.1, 126], [1.025, 62], [4.225, 254], [8.075, 485],
  ];

  function selfTest() {
    const failures = [];
    const rates = { first_hour_rate: 5, hourly_rate: 3, daily_cap: 25 };

    for (const [minutes, expected] of GOLDEN) {
      const actual = priceCents(rates, minutes) / 100;
      if (actual !== expected) {
        failures.push(`priceCents(${minutes}min) = $${actual.toFixed(2)}, expected $${expected.toFixed(2)}`);
      }
    }
    for (const [hours, expected] of GOLDEN_MINUTES) {
      const actual = hoursToMinutes(hours);
      if (actual !== expected) {
        failures.push(`hoursToMinutes(${hours}) = ${actual}, expected ${expected}`);
      }
    }
    return { passed: failures.length === 0, failures };
  }

  const result = selfTest();
  if (!result.passed) {
    console.warn(
      "Pricing: SELF-TEST FAILED — js/price.js and supabase/schema.sql have drifted apart.\n" +
      result.failures.join("\n")
    );
  }

  window.Pricing = {
    DEFAULT_RATES,
    hoursToMinutes,
    priceCents,
    quote,
    rateCard,
    money,
    formatCents,
    formatHours,
    normalizeRates,
    hasRates,
    selfTest,
  };
})();
