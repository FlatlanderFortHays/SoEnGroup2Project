// Owner portal: create garages, see live occupancy, and view a garage's live map.
initPortal("owner", (session) => {
  const form      = document.getElementById("garage-form");
  const nameEl    = document.getElementById("garage-name");
  const floorsEl  = document.getElementById("garage-floors");
  const rowsEl    = document.getElementById("garage-rows");
  const slotsEl   = document.getElementById("garage-slots");
  const listEl    = document.getElementById("garage-list");
  const msgEl     = document.getElementById("garage-msg");
  const firstHrEl = document.getElementById("garage-first-hour");
  const hourlyEl  = document.getElementById("garage-hourly");
  const capEl     = document.getElementById("garage-cap");

  // Read-only map panel
  const mapCard     = document.getElementById("map-card");
  const mapTitle    = document.getElementById("map-title");
  const mapSummary  = document.getElementById("map-summary");
  const mapViewport = document.getElementById("map-viewport");
  const mapMsg      = document.getElementById("map-msg");
  const mapAuto     = document.getElementById("map-auto");
  const mapZoom     = document.getElementById("map-zoom");

  let map          = null;       // canvas controller — lazily mounted on first open
  let garagesById  = new Map();  // id -> garage_availability row (instant title/summary on open)
  let mapGarageId  = null;
  let mapAutoTimer = null;
  let mapGen       = 0;          // race guard for the map panel

  async function loadGarages() {
    const { data, error } = await sb
      .from("garage_availability")
      .select("*")
      .eq("owner_id", session.id)
      .order("name");

    if (error) {
      listEl.innerHTML = `<li class="error">${escapeHtml(error.message)}</li>`;
      return;
    }
    garagesById = new Map(data.map((g) => [g.id, g]));
    if (!data.length) {
      listEl.innerHTML = `<li class="muted">No garages yet — add one above.</li>`;
      return;
    }
    // An un-migrated database has no rate columns; don't offer rate editing that
    // would only fail, and say why.
    const hasPricing = data.some((g) => Pricing.hasRates(g));
    if (!hasPricing) {
      msgEl.textContent = "⚠️ This database is missing the pricing columns — re-run supabase/schema.sql to set garage rates.";
      msgEl.className = "msg error";
    }

    listEl.innerHTML = data.map((g) => {
      const full = g.open_spots <= 0;
      const floorsTxt = g.floors && g.floors > 1 ? `${g.floors} floors · ` : "";
      const layout = g.rows && g.slots_per_row
        ? ` <span class="muted">· ${floorsTxt}${g.rows} rows × ${g.slots_per_row}</span>`
        : "";
      const rateBtn = hasPricing
        ? `<button class="btn btn-ghost rates-btn" type="button" data-garage-id="${g.id}">Rates</button>`
        : "";
      return `
        <li class="list-row" style="flex-wrap: wrap;">
          <span class="grow">
            <strong>${escapeHtml(g.name)}</strong>${layout}
            <br /><span class="muted">${escapeHtml(Pricing.rateCard(g))}</span>
          </span>
          <span class="badge ${full ? "badge-full" : ""}">
            ${g.open_spots}/${g.total_spots} open
          </span>
          ${rateBtn}
          <button class="btn btn-ghost map-view-btn" type="button" data-garage-id="${g.id}">View map</button>
          <div class="rates-editor hidden" data-editor-for="${g.id}" style="flex-basis: 100%;"></div>
        </li>`;
    }).join("");
  }

  // ---- Rate editing (UC13: owner sets the base rates for their own lot) ----
  function openRatesEditor(id) {
    const g = garagesById.get(Number(id));
    const box = listEl.querySelector(`.rates-editor[data-editor-for="${id}"]`);
    if (!g || !box) return;

    if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }

    const r = Pricing.normalizeRates(g);
    box.innerHTML = `
      <form class="row rates-form" data-garage-id="${g.id}" style="margin-top: 8px;">
        <label>First hour ($)
          <input class="rate-first" type="number" min="0" step="0.25" value="${r.first_hour_rate}" />
        </label>
        <label>Per hour after ($)
          <input class="rate-hourly" type="number" min="0" step="0.25" value="${r.hourly_rate}" />
        </label>
        <label>Daily cap ($)
          <input class="rate-cap" type="number" min="0" step="0.25" value="${r.daily_cap}" />
        </label>
        <button class="btn" type="submit">Save rates</button>
      </form>
      <p class="hint rate-preview"></p>
      <p class="msg rate-msg"></p>`;
    box.classList.remove("hidden");

    const form = box.querySelector(".rates-form");
    const preview = box.querySelector(".rate-preview");

    // Show the owner what their rate card actually charges, so they can see the daily
    // cap bite before they commit to it.
    function refreshPreview() {
      const rates = readRatesFrom(form);
      const sample = [1, 2, 4, 8, 24]
        .map((h) => `${h}h ${Pricing.quote(rates, h).formatted}`)
        .join(" · ");
      preview.textContent = `A driver would pay: ${sample}`;
    }
    form.addEventListener("input", refreshPreview);
    refreshPreview();
  }

  function readRatesFrom(form) {
    return {
      first_hour_rate: parseFloat(form.querySelector(".rate-first").value),
      hourly_rate:     parseFloat(form.querySelector(".rate-hourly").value),
      daily_cap:       parseFloat(form.querySelector(".rate-cap").value),
    };
  }

  // Rates must be real, non-negative numbers. A cap of 0 is legal — it means "no cap".
  function validateRates(r) {
    for (const v of [r.first_hour_rate, r.hourly_rate, r.daily_cap]) {
      if (!Number.isFinite(v) || v < 0) return "Rates must be 0 or more.";
    }
    return null;
  }

  async function saveRates(form) {
    const id = Number(form.dataset.garageId);
    const msg = form.parentElement.querySelector(".rate-msg");
    const rates = readRatesFrom(form);

    const problem = validateRates(rates);
    if (problem) { msg.textContent = problem; msg.className = "msg rate-msg error"; return; }

    const { error } = await sb.from("garages").update(rates).eq("id", id);
    if (error) {
      msg.textContent = error.message;
      msg.className = "msg rate-msg error";
      return;
    }

    // loadGarages() re-renders the list and takes this editor (and its message) with
    // it, so the confirmation goes in the page-level message instead.
    msgEl.textContent = "✅ Rates saved. New bookings use them; existing ones keep the price they were booked at.";
    msgEl.className = "msg success";
    loadGarages();
  }

  // ---- Read-only live map panel ----
  async function renderMap() {
    if (mapGarageId == null) return;
    const myGen = ++mapGen;
    try {
      const { garage, bySpot } = await GarageMap.load(mapGarageId);
      if (myGen !== mapGen || !map) return;  // a newer render started (or panel closed)
      mapSummary.textContent = `${garage.occupied} / ${garage.total_spots} occupied`;
      const drew = map.setData(garage, bySpot);
      if (!drew && mapAuto.checked) { mapAuto.checked = false; syncMapAuto(); }
      mapMsg.textContent = "";
      mapMsg.className = "msg";
    } catch (err) {
      if (myGen !== mapGen) return;
      if (err.code === "GM_NOT_FOUND") {
        closeMap();
        loadGarages();
        msgEl.textContent = "That garage is no longer available.";
      } else {
        mapMsg.textContent = err.message || String(err);
        mapMsg.className = "msg error";
      }
    }
  }

  function syncMapAuto() {
    if (mapAutoTimer) { clearInterval(mapAutoTimer); mapAutoTimer = null; }
    if (mapAuto.checked && mapGarageId != null) {
      mapAutoTimer = setInterval(renderMap, 5000);
    }
  }

  function openMap(id) {
    const cached = garagesById.get(Number(id));
    mapGarageId = Number(id);
    mapTitle.textContent = cached ? cached.name : "Garage map";
    mapSummary.textContent = cached ? `${cached.occupied} / ${cached.total_spots} occupied` : "";
    mapMsg.textContent = "";
    mapMsg.className = "msg";
    mapCard.classList.remove("hidden");   // unhide FIRST so the canvas can size (clientWidth > 0)
    if (!map) {
      map = GarageMap.mount(mapViewport, { onZoomChange: (z) => { mapZoom.value = z; } });
    }
    mapCard.scrollIntoView({ behavior: "smooth", block: "start" });
    renderMap();
    syncMapAuto();
  }

  function closeMap() {
    if (mapAutoTimer) { clearInterval(mapAutoTimer); mapAutoTimer = null; }
    mapGen++;            // invalidate any in-flight renderMap so it can't paint the closed panel
    mapGarageId = null;
    if (map) map.clear();
    mapCard.classList.add("hidden");
  }

  // ---- Events (bound once; list click is delegated so it survives re-render) ----
  listEl.addEventListener("click", (event) => {
    const mapBtn = event.target.closest(".map-view-btn");
    if (mapBtn) { openMap(mapBtn.dataset.garageId); return; }

    const rateBtn = event.target.closest(".rates-btn");
    if (rateBtn) openRatesEditor(rateBtn.dataset.garageId);
  });

  listEl.addEventListener("submit", (event) => {
    const form = event.target.closest(".rates-form");
    if (!form) return;
    event.preventDefault();
    saveRates(form);
  });
  document.getElementById("map-refresh").addEventListener("click", renderMap);
  document.getElementById("map-close").addEventListener("click", closeMap);
  mapAuto.addEventListener("change", syncMapAuto);
  mapZoom.addEventListener("input", () => { if (map) map.setZoom(mapZoom.value); });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    msgEl.textContent = "";
    msgEl.className = "msg error";   // saveRates may have left this green

    const name   = nameEl.value.trim();
    const floors = parseInt(floorsEl.value, 10);
    const rows   = parseInt(rowsEl.value, 10);
    const slots  = parseInt(slotsEl.value, 10);
    if (!name ||
        !Number.isInteger(floors) || floors < 1 ||
        !Number.isInteger(rows) || rows < 1 ||
        !Number.isInteger(slots) || slots < 1) {
      msgEl.textContent = "Enter a name, and at least 1 floor, 1 row, and 1 slot per row.";
      return;
    }

    const rates = {
      first_hour_rate: parseFloat(firstHrEl.value),
      hourly_rate:     parseFloat(hourlyEl.value),
      daily_cap:       parseFloat(capEl.value),
    };
    const rateProblem = validateRates(rates);
    if (rateProblem) { msgEl.textContent = rateProblem; return; }

    const garage = {
      owner_id: session.id,
      name,
      floors,
      rows,
      slots_per_row: slots,
      total_spots: floors * rows * slots,
      ...rates,
    };

    let { error } = await sb.from("garages").insert(garage);

    // PGRST204 = the database has no rate columns yet (schema.sql not re-run). Still
    // create the garage rather than blocking the owner outright; it picks up the
    // default rate card once the migration lands.
    if (error && error.code === "PGRST204") {
      const { first_hour_rate, hourly_rate, daily_cap, ...withoutRates } = garage;
      ({ error } = await sb.from("garages").insert(withoutRates));
      if (!error) {
        msgEl.textContent = "Garage created — but this database has no pricing columns, so your rates weren't saved. Re-run supabase/schema.sql.";
      }
    }

    if (error) { msgEl.textContent = error.message; return; }

    nameEl.value = "";
    floorsEl.value = "1";
    rowsEl.value = "4";
    slotsEl.value = "10";
    loadGarages();
  });

  loadGarages();
});
