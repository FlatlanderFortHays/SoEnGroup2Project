// ---------------------------------------------------------------------
//  Shared garage-map renderer.
//  Used by the public Garage Simulation page (js/simulation.js) AND the
//  Owner portal's read-only map panel (js/owner.js), so both draw the lot
//  exactly the same way — no duplicated render logic to drift.
//
//  Load AFTER supabaseClient.js (depends on the globals `sb` and `escapeHtml`).
//  Only defines an object at load time — no DOM access — so it is safe to load
//  before login.
// ---------------------------------------------------------------------
(function () {
  // Row index -> letter: 0->A, 25->Z, 26->AA, ...
  function rowLetter(i) {
    let s = "";
    i += 1;
    while (i > 0) {
      s = String.fromCharCode(65 + (i - 1) % 26) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  // One spot tile. `flat` is the canonical spot_number (used to look up the car);
  // `label` is what's shown (within-row position in lot view, or flat number in
  // the fallback grid); `name` is the human label for the tooltip (e.g. "A3").
  function spotTile(flat, label, name, bySpot) {
    const car = bySpot.get(flat);
    if (car) {
      const vehicle = `${car.color} ${car.make} ${car.model}`;
      const until   = new Date(car.parked_until).toLocaleString();
      const tip     = `${name} — ${vehicle} — ${car.license_plate} — until ${until}`;
      return `
        <div class="spot occupied" title="${escapeHtml(tip)}">
          <span class="spot-num">${label}${car.is_simulated ? " 🧪" : ""}</span>
          <span class="spot-plate mono">${escapeHtml(car.license_plate)}</span>
        </div>`;
    }
    return `
      <div class="spot available" title="${escapeHtml(name + " — open")}">
        <span class="spot-num">${label}</span>
      </div>`;
  }

  const GarageMap = {
    // Lots larger than this skip tile rendering (the live counts still update).
    MAX_SPOTS: 2500,

    // Fetch one garage's live state.
    // Resolves { garage, bySpot } where bySpot maps spot_number -> currently_parked row.
    // Throws an error tagged err.code === "GM_NOT_FOUND" if the garage row is gone
    // (PostgREST returns PGRST116 from .single() when no row matches); other
    // transport errors are rethrown as-is.
    async load(garageId) {
      const { data: garage, error: gErr } = await sb
        .from("garage_availability").select("*").eq("id", garageId).single();
      if (gErr) {
        if (gErr.code === "PGRST116") {
          const e = new Error("Garage not found");
          e.code = "GM_NOT_FOUND";
          throw e;
        }
        throw gErr;
      }

      const { data: parked, error: pErr } = await sb
        .from("currently_parked").select("*").eq("garage_id", garageId);
      if (pErr) throw pErr;

      const bySpot = new Map((parked || []).map((r) => [r.spot_number, r]));
      return { garage, bySpot };
    },

    // Paint the lot into mountEl (the node that receives class "lot"/"lot-grid").
    // Does NOT read selects, touch summary/msg lines, or bind buttons — callers
    // own their own chrome. Returns true if tiles were drawn, false if the lot is
    // over MAX_SPOTS (a notice is shown instead so the caller can react).
    render(mountEl, garage, bySpot) {
      if (garage.total_spots > GarageMap.MAX_SPOTS) {
        mountEl.className = "";
        mountEl.innerHTML =
          `<p class="map-notice">This lot has ${garage.total_spots} spots — ` +
          `the map is hidden for performance. The live counts above stay current.</p>`;
        return false;
      }

      if (garage.rows && garage.slots_per_row) {
        // Real-lot layout: floors → rows → aisles. Within a row, positions run
        // 1..slots_per_row; odds line up on one side of the aisle, evens on the
        // other (drive down row A: 1,3,5,7,9 on the left, 2,4,6,8,10 on the right).
        // Each spot is labelled with its full code: single-floor = "A3";
        // multi-floor = row + floor + zero-padded spot, e.g. "A203" (row A, floor 2, spot 03).
        mountEl.className = "lot";
        const floors        = garage.floors > 0 ? garage.floors : 1;
        const spotsPerFloor = garage.rows * garage.slots_per_row;
        const pad           = Math.max(2, String(garage.slots_per_row).length);
        const blocks = [];

        for (let f = 1; f <= floors; f++) {
          if (floors > 1) blocks.push(`<div class="floor-heading">Floor ${f}</div>`);
          const floorBase = (f - 1) * spotsPerFloor;  // flat spot_number before this floor

          for (let r = 0; r < garage.rows; r++) {
            const letter  = rowLetter(r);
            const rowBase = floorBase + r * garage.slots_per_row;
            const odds = [], evens = [];
            for (let p = 1; p <= garage.slots_per_row; p++) {
              const code = floors > 1
                ? `${letter}${f}${String(p).padStart(pad, "0")}`
                : `${letter}${p}`;
              const tile = spotTile(rowBase + p, code, code, bySpot);
              (p % 2 === 1 ? odds : evens).push(tile);
            }
            blocks.push(`
              <div class="lot-row">
                <div class="row-label">${letter}</div>
                <div class="row-lanes">
                  <div class="lane">${odds.join("")}</div>
                  <div class="aisle"></div>
                  <div class="lane">${evens.join("")}</div>
                </div>
              </div>`);
          }
        }
        mountEl.innerHTML = blocks.join("");
      } else {
        // Fallback for older garages that have no row/slot dimensions: flat grid.
        mountEl.className = "lot-grid";
        const tiles = [];
        for (let n = 1; n <= garage.total_spots; n++) {
          tiles.push(spotTile(n, n, `Spot ${n}`, bySpot));
        }
        mountEl.innerHTML = tiles.join("");
      }
      return true;
    },
  };

  window.GarageMap = GarageMap;
})();
