// ---------------------------------------------------------------------
//  Car colours — the ONE list of colours this app knows about.
//
//  It drives four things, so they can no longer drift apart:
//    1. the Color dropdown on the user portal   (user.html #car-color)
//    2. the colour swatch in "My cars" and on the tow page
//    3. how a car is painted on the map         (js/garageMap.js)
//    4. the colours "Simulate fill" picks from — this list is PASSED to the
//       simulate_fill() RPC as p_colors (js/user.js, js/simulation.js), so the
//       dropdown literally decides what the simulation produces.
//
//  `name` is STORED in cars.color and printed verbatim by every screen ("Navy Toyota
//  Corolla"), so it is Title Case. Keep every name ONE WORD: the lower-case slug used
//  for hex lookups and for assets/cars/<slug>-<size>.png is just name.toLowerCase() —
//  derived here, never stored.
//
//  The database keeps the other copy, as the car_color_names() function in
//  supabase/schema.sql. cars.color has a CHECK against it, and simulate_fill() falls
//  back to it. Two languages, one list each — the same situation the pricing engine is
//  in, so it gets the same answer as price_selftest()/Pricing.selfTest():
//  verifyAgainstDb() below asks the database on page load and console.errors on drift.
//
//  ADDING A COLOUR: add a row to PALETTE here AND to car_color_names() in
//  supabase/schema.sql, then re-run that file. Forget either half and the browser
//  console tells you on the very next page load.
//
//  Load AFTER supabaseClient.js (uses the global `sb`) and BEFORE garageMap.js
//  (which reads CarColors at load time).
// ---------------------------------------------------------------------
(function () {
  const PALETTE = [
    { name: "Black",  hex: "#1f2937", ink: "#fff" },
    { name: "White",  hex: "#e5e7eb", ink: "#111" },
    { name: "Silver", hex: "#cbd5e1", ink: "#111" },
    { name: "Gray",   hex: "#6b7280", ink: "#fff" },
    { name: "Red",    hex: "#dc2626", ink: "#fff" },
    { name: "Maroon", hex: "#7f1d1d", ink: "#fff" },
    { name: "Orange", hex: "#ea580c", ink: "#fff" },
    { name: "Yellow", hex: "#eab308", ink: "#111" },
    { name: "Gold",   hex: "#b8860b", ink: "#fff" },
    { name: "Green",  hex: "#16a34a", ink: "#fff" },
    { name: "Blue",   hex: "#2563eb", ink: "#fff" },
    { name: "Navy",   hex: "#1e3a8a", ink: "#fff" },
    { name: "Brown",  hex: "#78350f", ink: "#fff" },
  ];

  // Painted when a car's colour is not in the palette. After the CHECK constraint lands
  // that should be impossible — it stays as the safety net the map has always had.
  const NEUTRAL_HEX = "#9aa3af";

  const BY_KEY = new Map(PALETTE.map((c) => [c.name.toLowerCase(), c]));

  const names = () => PALETTE.map((c) => c.name);               // Title Case: stored + p_colors
  const keys  = () => PALETTE.map((c) => c.name.toLowerCase()); // sprite / hex keys
  const find  = (color) => BY_KEY.get(String(color || "").trim().toLowerCase()) || null;
  const hexOf = (color) => { const c = find(color); return c ? c.hex : null; };  // null => NEUTRAL_HEX
  const canonical = (color) => { const c = find(color); return c ? c.name : null; };

  // Fill a <select> with the palette. The disabled placeholder is the same pattern as
  // #booking-type in user.html, so form.reset() re-selects it and .value stays "" — which
  // is what keeps the "you didn't fill in every field" guard in js/user.js working.
  function fillSelect(el, selected) {
    if (!el) return;
    const keep = canonical(selected != null ? selected : el.value);
    el.innerHTML =
      `<option value="" disabled${keep ? "" : " selected"}>Color</option>` +
      PALETTE.map((c) =>
        `<option value="${c.name}"${c.name === keep ? " selected" : ""}` +
        ` style="background:${c.hex};color:${c.ink}">${c.name}</option>`
      ).join("");
  }

  // A 14px colour chip — the exact hex the map paints that car. Nothing here is user input
  // (the hex comes from PALETTE), so there is nothing to escape. Reuses .legend-swatch.
  function swatchHtml(color) {
    const hex = hexOf(color) || NEUTRAL_HEX;
    return `<span class="legend-swatch" style="background:${hex};flex:0 0 14px;` +
           `display:inline-block;vertical-align:-2px"></span>`;
  }

  // A tiny side-view car icon, filled with the car's exact palette hex — the vector answer
  // to "recolour the car" (works for the neutrals Silver/Gray/White/Black too, which a
  // hue-shifted raster can't do). Three silhouettes: compact hatch / normal sedan / large
  // SUV (taller cabin). Nothing here is user input (hex from PALETTE), so nothing to escape,
  // same as swatchHtml. Used by the "My Vehicles" list (js/user.js) and vehicle.html preview.
  function carSvg(color, size) {
    const hex = hexOf(color) || NEUTRAL_HEX;
    const s = String(size || "normal").toLowerCase();
    // Body at y14–23, wheels at y23; the cabin sits on top up to y16 (the body overlaps it).
    // compact/normal = a rounded sedan greenhouse (short roof, hood + trunk showing), body
    // width growing compact < normal. large = a WIDE body + a TALL, BOXY cabin with a long
    // low-radius roofline — a suburban SUV, clearly not a sedan.
    const P = {
      compact: { bw: 36, cx: 21, cw: 18, cy: 8, rx: 4 },   // Mini: narrow small sedan
      normal:  { bw: 48, cx: 18, cw: 24, cy: 8, rx: 4 },   // medium sedan
      large:   { bw: 58, cx: 10, cw: 44, cy: 3, rx: 1.5 }, // wide boxy SUV
    };
    const p = P[s] || P.normal;
    const bx = (60 - p.bw) / 2;
    const cabH = 16 - p.cy;
    const wheel = (wx) =>
      `<circle cx="${wx}" cy="23" r="4.5" fill="#1f2937"/>` +
      `<circle cx="${wx}" cy="23" r="1.8" fill="#cbd5e1"/>`;
    return `<svg class="car-svg" viewBox="0 0 60 28" width="46" height="22" role="img" aria-label="car">` +
      `<rect x="${p.cx}" y="${p.cy}" width="${p.cw}" height="${cabH + 3}" rx="${p.rx}" fill="${hex}"/>` +
      `<rect x="${p.cx + 3}" y="${p.cy + 2}" width="${p.cw - 6}" height="${cabH - 2}" rx="${Math.max(1, p.rx - 1)}" fill="rgba(255,255,255,0.6)"/>` +
      `<rect x="${bx}" y="14" width="${p.bw}" height="9" rx="4.5" fill="${hex}"/>` +
      wheel(bx + 7) + wheel(bx + p.bw - 7) +
      `</svg>`;
  }

  // The ONE place the app calls simulate_fill(), so js/user.js and js/simulation.js cannot
  // pass the palette differently (or one of them forget to pass it at all).
  // The retry covers the window where someone pulled the new JS but has NOT re-run
  // supabase/schema.sql: their database only has the 3-argument simulate_fill, PostgREST
  // answers PGRST202, and the Simulate button would otherwise just die.
  async function simulateFill(client, opts) {
    const base = {
      p_garage_id: Number(opts.garageId),
      p_count: opts.count === undefined ? null : opts.count,
      p_hours: opts.hours,
    };
    let res = await client.rpc("simulate_fill", Object.assign({ p_colors: names() }, base));
    if (res.error && (res.error.code === "PGRST202" ||
                      /schema cache/i.test(res.error.message || ""))) {
      console.warn("CarColors: this database's simulate_fill has no p_colors yet — " +
                   "re-run supabase/schema.sql. Falling back to the old 3-argument call.");
      res = await client.rpc("simulate_fill", base);
    }
    return res;
  }

  // ---- Drift guard: the palette's answer to price_selftest() ----------------------
  // The JS list and car_color_names() are two copies of one list. price_selftest() can only
  // be run by a human in the SQL editor; this list is 13 short strings, so we can afford to
  // just ASK the database on every page load and shout if they disagree. Fire-and-forget:
  // never blocks a render, never shown to the user. It is a message for whoever edited the
  // palette and forgot the other half.
  async function verifyAgainstDb() {
    if (typeof sb === "undefined" || !sb) return null;

    const { data, error } = await sb.rpc("car_color_names");
    if (error) {
      console.warn("CarColors: could not read car_color_names() — re-run " +
                   "supabase/schema.sql. (" + error.message + ")");
      return null;
    }

    const db = new Set(data || []);
    const problems = [];
    for (const c of PALETTE) {
      if (!db.has(c.name)) {
        problems.push(`"${c.name}" is in js/carColors.js but NOT in the database — ` +
                      `adding a car in it will be REJECTED by cars_color_check`);
      }
    }
    for (const n of db) {
      if (!BY_KEY.has(String(n).toLowerCase())) {
        problems.push(`"${n}" is in the database but NOT in js/carColors.js — ` +
                      `cars in it paint neutral grey`);
      }
    }
    if (problems.length) {
      console.error("CarColors: PALETTE DRIFT between js/carColors.js and supabase/schema.sql:\n  " +
                    problems.join("\n  ") +
                    "\n  Fix: make the two lists match, then re-run supabase/schema.sql.");
    }
    return { passed: problems.length === 0, problems };
  }

  verifyAgainstDb();   // console only

  window.CarColors = {
    PALETTE,
    NEUTRAL_HEX,
    names,
    keys,
    find,
    hexOf,
    canonical,
    fillSelect,
    swatchHtml,
    carSvg,
    simulateFill,
    verifyAgainstDb,
  };
})();
