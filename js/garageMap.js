// ---------------------------------------------------------------------
//  Shared garage-map renderer — HTML5 canvas edition.
//  Used by the public Garage Simulation page (js/simulation.js) AND the
//  Owner portal's read-only map panel (js/owner.js). Both drive the same
//  controller, so there is one renderer and no duplicated logic.
//
//  Load AFTER supabaseClient.js (globals `sb`, `escapeHtml`) and AFTER carColors.js
//  (global `CarColors`). This file no longer keeps a colour list of its own — every car
//  colour and hex comes from js/carColors.js, which is also what fills the Color dropdown
//  and what simulate_fill() paints with.
//
//  Pixel-art look: black asphalt, yellow stall lines, bold-yellow spot codes,
//  and per-(color,size) car sprites with a drawn EV badge. One floor is shown
//  at a time in the big canvas; other floors appear as clickable "slab"
//  thumbnails in a left rail. The engine renders statically today but ships an
//  entity/loop + reservation-id diff so movement (cars parking, tow truck) is
//  additive later, not a rewrite.
//
//  Public API:
//    GarageMap.load(garageId) -> { garage, bySpot }      (unchanged data seam)
//    GarageMap.mount(container, options) -> controller
//      controller.setData(garage, bySpot) -> boolean      (false = over cap)
//      controller.setFloor(n) / setZoom(level) / clear() / resize() / destroy()
// ---------------------------------------------------------------------
(function () {
  const MAX_SPOTS = 2500;

  // Sprite matrix = the shared palette (js/carColors.js), lower-cased for filenames:
  // assets/cars/<colour>-<size>.png. Adding a colour to the dropdown adds it here for
  // free — the matrix is 13 x 3 now, not 7 x 3.
  const CAR_COLORS = CarColors.keys();
  const CAR_SIZES  = ["compact", "normal", "large"];

  // Cars currently render as tidy coloured blocks (no art yet). Once pixel-art
  // PNGs are committed to assets/cars/ (named "<color>-<size>.png", e.g.
  // "red-normal.png", plus "neutral.png"), flip this to true — the loader +
  // fallback chain below will pick them up automatically.
  const SPRITES_ENABLED = false;

  // World-pixel geometry at zoom 1. Stalls are deeper than wide (cars nose in).
  const STALL_W = 30, STALL_D = 46, GAP = 6, AISLE = 26, ROW_GAP = 24,
        ROW_LABEL_W = 28, PAD = 18;

  // Palette
  const ASPHALT = "#141414", LINE = "#F6C915", LABEL = "#FFDE3A",
        EV = "#22c55e", SIM = "#a855f7", NEUTRAL_CAR = CarColors.NEUTRAL_HEX;

  // Row index -> letter: 0->A, 25->Z, 26->AA, ...
  function rowLetter(i) {
    let s = "";
    i += 1;
    while (i > 0) { s = String.fromCharCode(65 + (i - 1) % 26) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- Sprite cache (shared across all controllers) ----
  const spriteCache = new Map();  // key -> Image (may still be loading)
  function loadSprite(base, key, onReady) {
    const cacheKey = base + key;
    let img = spriteCache.get(cacheKey);
    if (img) return img;
    img = new Image();
    img.dataset && (img.dataset.key = key);
    img.onload = () => onReady && onReady();
    img.onerror = () => { img._failed = true; console.warn(`GarageMap: missing car sprite ${base}${key}.png — using neutral.`); };
    img.src = `${base}${key}.png`;
    spriteCache.set(cacheKey, img);
    return img;
  }
  // Fraction of a stall's DEPTH (nose-to-tail length) a car of each size fills
  // (also conveys size if only a per-colour sprite exists).
  const SIZE_SCALE = { compact: 0.74, normal: 0.9, large: 1.0 };
  // A car is far narrower than it is long (~1.8m in a ~2.6m-wide stall), so it fills
  // less of the stall's WIDTH than its depth — otherwise the block looks fat.
  const WIDTH_RATIO = 0.7;

  // Candidate sprite keys for a car, most specific first (color-size ->
  // color-normal -> neutral) so a partial sprite set still renders sensibly.
  function spriteKeysFor(car) {
    const color = String(car.color || "").toLowerCase();
    const size  = String(car.size || "normal").toLowerCase();
    const keys = [];
    if (CAR_COLORS.includes(color)) {
      if (CAR_SIZES.includes(size)) keys.push(`${color}-${size}`);
      keys.push(`${color}-normal`);
    }
    keys.push("neutral");
    return keys;
  }

  // ---- Data seam (unchanged) ----
  async function load(garageId) {
    const { data: garage, error: gErr } = await sb
      .from("garage_availability").select("*").eq("id", garageId).single();
    if (gErr) {
      if (gErr.code === "PGRST116") { const e = new Error("Garage not found"); e.code = "GM_NOT_FOUND"; throw e; }
      throw gErr;
    }
    const { data: parked, error: pErr } = await sb
      .from("currently_parked").select("*").eq("garage_id", garageId);
    if (pErr) throw pErr;
    const bySpot = new Map((parked || []).map((r) => [r.spot_number, r]));
    return { garage, bySpot };
  }

  // ---- Controller ----
  function mount(container, options = {}) {
    const spriteBase = options.spriteBase || "assets/cars/";
    const viewportHeightCss = options.viewportHeightCss || Math.round((window.innerHeight || 800) * 0.7);
    const spotMeta = typeof options.spotMeta === "function" ? options.spotMeta : () => null;
    const onZoomChange = typeof options.onZoomChange === "function" ? options.onZoomChange : () => {};

    // --- DOM: stage = [rail][canvas] ---
    container.classList.add("map-viewport");
    container.innerHTML = "";
    container.style.position = "relative";
    const stage = document.createElement("div");
    stage.className = "map-stage";
    const rail = document.createElement("div");
    rail.className = "floor-rail hidden";
    const canvas = document.createElement("canvas");
    canvas.className = "map-canvas";
    canvas.setAttribute("role", "img");
    const tooltip = document.createElement("div");
    tooltip.className = "map-tooltip hidden";
    const srList = document.createElement("ul");
    srList.className = "sr-only";
    stage.appendChild(rail);
    stage.appendChild(canvas);
    container.appendChild(stage);
    container.appendChild(tooltip);
    container.appendChild(srList);
    const ctx = canvas.getContext("2d");

    // --- state ---
    let garage = null, bySpot = new Map();
    let activeFloor = 1, spotsPerFloor = 1, floors = 1;
    let spots = [], worldW = 0, worldH = 0;
    const cam = { x: 0, y: 0, zoom: 1 };
    let viewW = 0, viewH = viewportHeightCss, dpr = 1;
    let dirty = false, rafId = null;
    let hoverFlat = null;
    const entities = [];          // future animation actors (empty in v1)
    let prevKeys = new Set();     // reservation ids seen last setData (diff seam)
    let aisles = [];              // world-y of each row's aisle centre line

    // ---------- geometry ----------
    function buildGeometry(g, floor) {
      spots = []; aisles = [];
      const rows = g.rows, spr = g.slots_per_row;
      if (rows && spr) {
        spotsPerFloor = rows * spr;
        const floorBase = (floor - 1) * spotsPerFloor;
        const pad = Math.max(2, String(spr).length);
        const rowStartX = PAD + ROW_LABEL_W + GAP;
        const numCols = Math.ceil(spr / 2);
        const rowH = 2 * STALL_D + AISLE;
        for (let r = 0; r < rows; r++) {
          const letter = rowLetter(r);
          const rowTop = PAD + r * (rowH + ROW_GAP);
          aisles.push(rowTop + STALL_D + AISLE / 2);
          for (let p = 1; p <= spr; p++) {
            const col = Math.floor((p - 1) / 2);
            const isOdd = (p % 2 === 1);
            const x = rowStartX + col * (STALL_W + GAP);
            const y = isOdd ? rowTop : rowTop + STALL_D + AISLE;
            const code = floors > 1 ? `${letter}${floor}${String(p).padStart(pad, "0")}` : `${letter}${p}`;
            spots.push({
              flat: floorBase + r * spr + p, label: code, name: code,
              x, y, w: STALL_W, h: STALL_D, faceDown: isOdd,
              aisleY: rowTop + STALL_D + AISLE / 2, letter,
            });
          }
        }
        worldW = rowStartX + numCols * STALL_W + (numCols - 1) * GAP + PAD;
        worldH = PAD + rows * (rowH + ROW_GAP) - ROW_GAP + PAD;
      } else {
        // Fallback: no row/slot dimensions -> flat wrapped grid, single floor.
        spotsPerFloor = g.total_spots;
        const n = g.total_spots;
        const cols = clamp(Math.round(Math.sqrt(n) * 1.6), 1, 30);
        for (let i = 1; i <= n; i++) {
          const c = (i - 1) % cols, rr = Math.floor((i - 1) / cols);
          spots.push({
            flat: i, label: String(i), name: `Spot ${i}`,
            x: PAD + c * (STALL_W + GAP), y: PAD + rr * (STALL_D + GAP),
            w: STALL_W, h: STALL_D, faceDown: false, aisleY: null, letter: "",
          });
        }
        worldW = PAD + cols * (STALL_W + GAP) - GAP + PAD;
        worldH = PAD + Math.ceil(n / cols) * (STALL_D + GAP) - GAP + PAD;
      }
    }

    // ---------- camera ----------
    const w2sx = (wx) => (wx - cam.x) * cam.zoom;
    const w2sy = (wy) => (wy - cam.y) * cam.zoom;
    const s2wx = (sx) => sx / cam.zoom + cam.x;
    const s2wy = (sy) => sy / cam.zoom + cam.y;

    // zoom = screen px per world px. The slider/onZoomChange speak in a FACTOR
    // relative to fit-to-view: 1 = whole floor visible, up to 8x zoomed in.
    function fitZoom() { return worldW && worldH ? Math.min(viewW / worldW, viewH / worldH) : 1; }
    function zoomBounds() { const f = fitZoom(); return { min: f, max: f * 8 }; }
    function zoomFactor() { const f = fitZoom(); return f ? cam.zoom / f : 1; }

    function clampCamera() {
      const { min, max } = zoomBounds();
      cam.zoom = clamp(cam.zoom, min, max);
      const visW = viewW / cam.zoom, visH = viewH / cam.zoom;
      cam.x = worldW <= visW ? (worldW - visW) / 2 : clamp(cam.x, 0, worldW - visW);
      cam.y = worldH <= visH ? (worldH - visH) / 2 : clamp(cam.y, 0, worldH - visH);
    }
    function fitCamera() { cam.zoom = fitZoom(); clampCamera(); onZoomChange(zoomFactor()); }

    function zoomAbout(newZoom, sx, sy) {
      const wx = s2wx(sx), wy = s2wy(sy);
      const b = zoomBounds();
      cam.zoom = clamp(newZoom, b.min, b.max);
      cam.x = wx - sx / cam.zoom;
      cam.y = wy - sy / cam.zoom;
      clampCamera();
      onZoomChange(zoomFactor());
      invalidate();
    }

    // ---------- drawing ----------
    function invalidate() { dirty = true; if (!rafId) rafId = requestAnimationFrame(tick); }
    function tick() {
      rafId = null;
      const animating = entities.some((e) => e.moving);
      if (dirty || animating) draw();
      dirty = false;
      if (animating) { rafId = requestAnimationFrame(tick); }
    }

    function draw() {
      ctx.clearRect(0, 0, viewW, viewH);
      ctx.fillStyle = ASPHALT;
      ctx.fillRect(0, 0, viewW, viewH);
      if (!garage) return;
      if (garage.total_spots > MAX_SPOTS) return drawNotice();

      // visible world rect (culling)
      const vx0 = s2wx(0), vy0 = s2wy(0), vx1 = s2wx(viewW), vy1 = s2wy(viewH);
      const z = cam.zoom;
      const sw = Math.max(1, Math.round(STALL_W * z));
      const showLabels = sw >= 24;

      const ax0 = w2sx(PAD), ax1 = w2sx(worldW - PAD);

      // driving-aisle bands (lighter asphalt where cars pull in), one per row
      const bandH = Math.max(1, Math.round(AISLE * z));
      ctx.fillStyle = "#1e1e1e";
      for (const ay of aisles) {
        const y = Math.round(w2sy(ay) - bandH / 2);
        if (y + bandH < 0 || y > viewH) continue;
        ctx.fillRect(Math.round(ax0), y, Math.round(ax1 - ax0), bandH);
      }

      // aisle centre lines (dashed yellow), one per row
      ctx.strokeStyle = "rgba(246,201,21,0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 5]);
      for (const ay of aisles) {
        const y = Math.round(w2sy(ay));
        if (y < -4 || y > viewH + 4) continue;
        ctx.beginPath(); ctx.moveTo(ax0, y); ctx.lineTo(ax1, y); ctx.stroke();
      }
      ctx.setLineDash([]);

      // outer boundary wall / curb framing the level
      {
        const inset = PAD / 2;
        ctx.strokeStyle = "#3a3a3a";
        ctx.lineWidth = Math.max(2, Math.round(5 * z));
        roundRect(w2sx(inset), w2sy(inset), (worldW - inset * 2) * z, (worldH - inset * 2) * z,
                  Math.max(2, Math.round(6 * z)));
        ctx.stroke();
      }

      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      const fontPx = clamp(Math.round(STALL_W * z * 0.34), 7, 15);

      for (const s of spots) {
        if (s.x + s.w < vx0 || s.x > vx1 || s.y + s.h < vy0 || s.y > vy1) continue;
        const X = Math.round(w2sx(s.x)), Y = Math.round(w2sy(s.y));
        const w = sw, h = Math.max(1, Math.round(STALL_D * z));

        // stall outline: sides + back (open toward the aisle)
        ctx.strokeStyle = LINE;
        ctx.lineWidth = Math.max(1, Math.round(z));
        ctx.beginPath();
        if (s.aisleY == null) {          // fallback grid: full box
          ctx.rect(X, Y, w, h);
        } else if (s.faceDown) {          // aisle below -> back on top
          ctx.moveTo(X, Y + h); ctx.lineTo(X, Y); ctx.lineTo(X + w, Y); ctx.lineTo(X + w, Y + h);
        } else {                          // aisle above -> back on bottom
          ctx.moveTo(X, Y); ctx.lineTo(X, Y + h); ctx.lineTo(X + w, Y + h); ctx.lineTo(X + w, Y);
        }
        ctx.stroke();

        const car = bySpot.get(s.flat);
        if (car) drawCar(car, X, Y, w, h, s.faceDown);

        if (showLabels) {
          ctx.font = `bold ${fontPx}px ui-monospace, "Cascadia Code", Menlo, Consolas, monospace`;
          const ly = s.faceDown ? Y + fontPx * 0.9 : Y + h - fontPx * 0.9;
          ctx.lineJoin = "round";
          ctx.lineWidth = Math.max(2, fontPx * 0.3);
          ctx.strokeStyle = "rgba(0,0,0,0.85)";   // dark halo → legible on light cars
          ctx.strokeText(s.label, X + w / 2, ly);
          ctx.fillStyle = LABEL;
          ctx.fillText(s.label, X + w / 2, ly);
        }

        if (car && car.is_ev) drawEvBadge(X, Y, w);
        if (car && car.is_simulated) { ctx.fillStyle = SIM; ctx.fillRect(X + 2, Y + h - 5, Math.max(4, w * 0.22), 3); }

        if (s.flat === hoverFlat) {
          ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
          ctx.strokeRect(X + 1, Y + 1, w - 2, h - 2);
        }
      }
    }

    // Best available sprite for a car (or null → caller draws a coloured block).
    function resolveSprite(car) {
      if (!SPRITES_ENABLED) return null;   // colored-block mode: no image loads / 404s
      let loading = null;
      for (const key of spriteKeysFor(car)) {
        const img = loadSprite(spriteBase, key, invalidate);
        if (img.complete && img.naturalWidth && !img._failed) return img;
        if (!img._failed && loading == null) loading = img;   // remember one still loading
      }
      return null;   // nothing ready; caller draws the coloured placeholder
    }

    function drawCar(car, X, Y, w, h, faceDown) {
      const scale = SIZE_SCALE[String(car.size || "normal").toLowerCase()] || 0.9;
      const dw = Math.round(w * scale * WIDTH_RATIO), dh = Math.round(h * scale);
      const cx = X + w / 2, cy = Y + h / 2;
      const img = resolveSprite(car);
      if (img) {
        ctx.save();
        ctx.translate(cx, cy);
        if (faceDown) ctx.scale(1, -1);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
      } else {
        drawCarBlock(car, cx, cy, dw, dh, faceDown);
      }
    }

    // A recognisable top-down car drawn from primitives (no sprite): body +
    // windshield/rear window + wheels. Front points toward the aisle.
    function drawCarBlock(car, cx, cy, dw, dh, faceDown) {
      const body = knownColor(car.color) || NEUTRAL_CAR;
      const bx = cx - dw / 2, by = cy - dh / 2;
      if (dw < 8 || dh < 10) {                 // too small for detail — flat rect
        ctx.fillStyle = body; ctx.fillRect(bx, by, dw, dh); return;
      }
      // wheels first, peeking outside the body sides (front + rear axle)
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      const ww = Math.max(2, Math.round(dw * 0.16)), wh = Math.max(2, Math.round(dh * 0.16));
      for (const wy of [by + dh * 0.16, by + dh * 0.68]) {
        roundRect(bx - ww * 0.4, wy, ww, wh, 1); ctx.fill();
        roundRect(bx + dw - ww * 0.6, wy, ww, wh, 1); ctx.fill();
      }
      // body + outline
      const rad = Math.max(2, Math.round(dw * 0.22));
      ctx.fillStyle = body; roundRect(bx, by, dw, dh, rad); ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.lineWidth = 1;
      roundRect(bx, by, dw, dh, rad); ctx.stroke();
      // windows: bigger windshield near the front, smaller rear window at the back
      ctx.fillStyle = "rgba(210,230,255,0.5)";
      const wsH = Math.max(2, Math.round(dh * 0.2)), rwH = Math.max(2, Math.round(dh * 0.14));
      const wsY = faceDown ? by + dh - wsH - dh * 0.14 : by + dh * 0.14;
      const rwY = faceDown ? by + dh * 0.16 : by + dh - rwH - dh * 0.16;
      ctx.fillRect(Math.round(cx - dw * 0.31), Math.round(wsY), Math.round(dw * 0.62), wsH);
      ctx.fillRect(Math.round(cx - dw * 0.26), Math.round(rwY), Math.round(dw * 0.52), rwH);
    }

    function drawEvBadge(X, Y, w) {
      const r = Math.max(6, Math.round(w * 0.34));
      const bx = X + w - r - 1, by = Y + 1;
      ctx.fillStyle = "#06280f"; roundRect(bx - 1.5, by - 1.5, r + 3, r + 3, 3); ctx.fill();  // dark ring
      ctx.fillStyle = EV; roundRect(bx, by, r, r, 3); ctx.fill();
      // white lightning bolt
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(bx + r * 0.55, by + r * 0.15);
      ctx.lineTo(bx + r * 0.3, by + r * 0.55);
      ctx.lineTo(bx + r * 0.48, by + r * 0.55);
      ctx.lineTo(bx + r * 0.42, by + r * 0.85);
      ctx.lineTo(bx + r * 0.72, by + r * 0.42);
      ctx.lineTo(bx + r * 0.52, by + r * 0.42);
      ctx.closePath(); ctx.fill();
    }

    function roundRect(x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    // The name -> hex map is the shared palette (js/carColors.js) — the same list that
    // fills the Color dropdown and that simulate_fill() paints from. null for an unknown
    // colour, so both callers below still fall back to NEUTRAL_CAR.
    function knownColor(c) {
      return CarColors.hexOf(c);
    }

    function drawNotice() {
      ctx.fillStyle = "#cbd5e1";
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const msg = `This lot has ${garage.total_spots} spots — map hidden for performance.`;
      ctx.fillText(msg, viewW / 2, viewH / 2 - 10);
      ctx.fillStyle = "#94a3b8"; ctx.font = "13px system-ui, sans-serif";
      ctx.fillText("The live counts above stay current.", viewW / 2, viewH / 2 + 12);
    }

    // ---------- floor rail ----------
    function floorOf(flat) { return Math.floor((flat - 1) / spotsPerFloor) + 1; }

    function buildRail() {
      rail.innerHTML = "";
      if (floors <= 1) { rail.classList.add("hidden"); return; }
      rail.classList.remove("hidden");
      // occupancy per floor
      const occ = new Array(floors + 1).fill(0);
      for (const [flat] of bySpot) { const f = floorOf(flat); if (f >= 1 && f <= floors) occ[f]++; }
      const perFloor = garage.rows && garage.slots_per_row ? garage.rows * garage.slots_per_row : garage.total_spots;
      for (let f = floors; f >= 1; f--) {
        const slab = document.createElement("button");
        slab.type = "button";
        slab.className = "floor-slab" + (f === activeFloor ? " active" : "");
        slab.dataset.floor = String(f);
        const thumb = document.createElement("canvas");
        thumb.className = "floor-thumb"; thumb.width = 150; thumb.height = 96;
        const cap = document.createElement("span");
        cap.className = "floor-cap";
        cap.textContent = `${f}F · ${occ[f]}/${perFloor}`;
        slab.appendChild(thumb); slab.appendChild(cap);
        slab.addEventListener("click", () => setFloor(f));
        rail.appendChild(slab);
        drawThumb(f, thumb);
      }
    }

    function drawThumb(floor, cv) {
      const tctx = cv.getContext("2d");
      const saved = spots;                 // reuse buildGeometry, then restore active floor
      buildGeometry(garage, floor);
      const gW = worldW, gH = worldH, floorSpots = spots, floorAisles = aisles.slice();
      spots = saved;
      buildGeometry(garage, activeFloor);  // restore

      tctx.imageSmoothingEnabled = false;
      tctx.fillStyle = ASPHALT; tctx.fillRect(0, 0, cv.width, cv.height);
      const scale = Math.min((cv.width - 8) / gW, (cv.height - 8) / gH);
      const ox = (cv.width - gW * scale) / 2, oy = (cv.height - gH * scale) / 2;

      // faint driving-aisle bands
      tctx.fillStyle = "#242424";
      for (const ay of floorAisles) {
        tctx.fillRect(ox + PAD * scale, oy + (ay - AISLE / 2) * scale,
                      (gW - 2 * PAD) * scale, Math.max(1, AISLE * scale));
      }
      // stalls as filled cells: empty = subtle grey, occupied = car colour
      for (const s of floorSpots) {
        const x = ox + s.x * scale, y = oy + s.y * scale;
        const w = Math.max(1, s.w * scale), h = Math.max(1, s.h * scale);
        const car = bySpot.get(s.flat);
        tctx.fillStyle = car ? (knownColor(car.color) || NEUTRAL_CAR) : "#2a2a2a";
        tctx.fillRect(x, y, w, h);
      }
    }

    // ---------- accessibility fallback ----------
    function updateAria() {
      if (!garage) { canvas.setAttribute("aria-label", "Empty garage map."); srList.innerHTML = ""; return; }
      canvas.setAttribute("aria-label",
        `${garage.name}: ${garage.occupied} of ${garage.total_spots} spots occupied, ${floors} floor(s).`);
      const rows = [];
      let count = 0;
      for (const [, car] of bySpot) {
        if (count++ >= 500) break;
        rows.push(`<li>Spot ${escapeHtml(String(car.spot_number))}: ${escapeHtml(car.color)} ${escapeHtml(car.make)} ${escapeHtml(car.model)}, ${escapeHtml(car.license_plate)}</li>`);
      }
      srList.innerHTML = rows.join("");
    }

    // ---------- tooltip / hit-test ----------
    function spotAt(sx, sy) {
      const wx = s2wx(sx), wy = s2wy(sy);
      for (const s of spots) {
        if (wx >= s.x && wx <= s.x + s.w && wy >= s.y && wy <= s.y + s.h) return s;
      }
      return null;
    }
    function showTooltipFor(spot, sx, sy) {
      const car = spot && bySpot.get(spot.flat);
      if (!car) { hideTooltip(); if (hoverFlat !== null) { hoverFlat = null; invalidate(); } return; }
      if (hoverFlat !== spot.flat) { hoverFlat = spot.flat; invalidate(); }
      const bits = [`${car.color} ${car.make} ${car.model}`];
      const tags = [car.size, car.is_ev ? "EV" : null].filter(Boolean);
      const detail = `${spot.name} — ${bits[0]}${tags.length ? ` (${tags.join(", ")})` : ""} — ${car.license_plate} — until ${new Date(car.parked_until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      tooltip.textContent = detail;   // textContent = safe, no escaping needed
      tooltip.classList.remove("hidden");
      // sx/sy are canvas-relative; the tooltip is positioned within the viewport, so
      // shift by the canvas's own offset — works whether the rail is a left column
      // (offsetLeft = rail width) or a bottom strip (offsetLeft/Top = 0).
      const ox = canvas.offsetLeft, oy = canvas.offsetTop;
      let tx = ox + sx + 12, ty = oy + sy + 12;
      const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
      if (tx + tw > container.clientWidth) tx = ox + sx - tw - 12;
      if (ty + th > container.clientHeight) ty = container.clientHeight - th - 4;
      tooltip.style.left = tx + "px"; tooltip.style.top = ty + "px";
    }
    function hideTooltip() { tooltip.classList.add("hidden"); }

    // ---------- pointer input (pan / zoom / hover) ----------
    const pointers = new Map();   // pointerId -> {x,y}
    let dragging = false, moved = 0, last = null, pinchDist = 0;

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pointers.size === 1) { dragging = true; moved = 0; last = { x: e.offsetX, y: e.offsetY }; canvas.classList.add("grabbing"); hideTooltip(); }
      else if (pointers.size === 2) { dragging = false; pinchDist = twoDist(); }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pointers.size === 2) { doPinch(); return; }
      if (dragging && last) {
        const dx = e.offsetX - last.x, dy = e.offsetY - last.y;
        moved += Math.abs(dx) + Math.abs(dy);
        cam.x -= dx / cam.zoom; cam.y -= dy / cam.zoom;
        clampCamera(); last = { x: e.offsetX, y: e.offsetY }; invalidate();
      } else {
        showTooltipFor(spotAt(e.offsetX, e.offsetY), e.offsetX, e.offsetY);
      }
    });
    function endPointer(e) {
      const wasTap = dragging && moved < 8;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) { dragging = false; last = null; canvas.classList.remove("grabbing"); }
      if (wasTap) showTooltipFor(spotAt(e.offsetX, e.offsetY), e.offsetX, e.offsetY);
    }
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("pointerleave", () => { if (!dragging) hideTooltip(); });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomAbout(cam.zoom * factor, e.offsetX, e.offsetY);
    }, { passive: false });

    function twoPts() { return [...pointers.values()]; }
    function twoDist() { const [a, b] = twoPts(); return Math.hypot(a.x - b.x, a.y - b.y); }
    function twoMid() { const [a, b] = twoPts(); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    function doPinch() {
      if (pointers.size !== 2) return;
      const d = twoDist(), m = twoMid();
      if (pinchDist > 0 && d > 0) zoomAbout(cam.zoom * (d / pinchDist), m.x, m.y);
      pinchDist = d;
    }

    // ---------- sizing ----------
    function resize() {
      const cw = container.clientWidth;
      if (cw === 0) return;               // hidden (owner card); ResizeObserver re-fires on show
      // The rail is a left column on wide screens but a horizontal strip below the
      // canvas on phones (see the max-width:640px block in css/styles.css). Subtract
      // whichever axis it actually occupies so the canvas fills the rest.
      const railHidden = rail.classList.contains("hidden");
      const railHorizontal = getComputedStyle(stage).flexDirection.startsWith("column");
      const railW = (railHidden || railHorizontal) ? 0 : rail.offsetWidth;
      const railH = (railHidden || !railHorizontal) ? 0 : rail.offsetHeight;
      viewW = Math.max(60, cw - railW);
      viewH = railHorizontal
        ? Math.max(120, (container.clientHeight || viewportHeightCss) - railH)
        : viewportHeightCss;             // desktop path unchanged
      dpr = window.devicePixelRatio || 1;
      canvas.style.width = viewW + "px";
      canvas.style.height = viewH + "px";
      canvas.width = Math.round(viewW * dpr);
      canvas.height = Math.round(viewH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      clampCamera();
      invalidate();
    }
    const ro = new ResizeObserver(() => resize());
    ro.observe(container);

    // preload sprites (only once art exists — otherwise avoid a burst of 404s)
    if (SPRITES_ENABLED) {
      for (const c of CAR_COLORS) for (const s of CAR_SIZES) loadSprite(spriteBase, `${c}-${s}`, invalidate);
      loadSprite(spriteBase, "neutral", invalidate);
    }

    // ---------- public methods ----------
    function setData(g, map) {
      garage = g; bySpot = map || new Map();
      floors = g.floors > 0 ? g.floors : 1;
      // diff seam: track appearances/removals by reservation id (stable identity)
      const keys = new Set(); for (const [, car] of bySpot) keys.add(car.id);
      prevKeys = keys;   // (added/removed computed here later feed animation)
      if (activeFloor > floors) activeFloor = 1;

      if (g.total_spots > MAX_SPOTS) {     // over cap: skip geometry, draw a notice
        spots = []; aisles = [];
        rail.innerHTML = ""; rail.classList.add("hidden");
        resize(); updateAria(); invalidate();
        return false;
      }

      buildGeometry(g, activeFloor);
      buildRail();          // sets rail visibility (affects canvas width)
      resize();             // size canvas after rail is known
      fitCamera();
      updateAria();
      invalidate();
      return true;
    }
    function setFloor(n) {
      if (!garage || n < 1 || n > floors || n === activeFloor) return;
      activeFloor = n;
      buildGeometry(garage, activeFloor);
      rail.querySelectorAll(".floor-slab").forEach((el) =>
        el.classList.toggle("active", Number(el.dataset.floor) === activeFloor));
      hoverFlat = null; hideTooltip();
      fitCamera(); invalidate();
    }
    function setZoom(factor) {
      const f = parseFloat(factor);
      if (!Number.isFinite(f)) return;
      zoomAbout(fitZoom() * clamp(f, 1, 8), viewW / 2, viewH / 2);  // factor 1..8 about centre
    }
    function clear() {
      garage = null; bySpot = new Map(); spots = []; hoverFlat = null;
      rail.innerHTML = ""; rail.classList.add("hidden");
      srList.innerHTML = ""; hideTooltip();
      ctx.clearRect(0, 0, viewW, viewH); ctx.fillStyle = ASPHALT; ctx.fillRect(0, 0, viewW, viewH);
    }
    function destroy() { ro.disconnect(); if (rafId) cancelAnimationFrame(rafId); container.innerHTML = ""; }

    resize();
    return { setData, setFloor, setZoom, clear, resize, destroy };
  }

  window.GarageMap = { MAX_SPOTS, load, mount };
})();
