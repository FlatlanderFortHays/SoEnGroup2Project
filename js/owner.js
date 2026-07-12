// Owner portal: create garages, see live occupancy, and view a garage's live map.
initPortal("owner", (session) => {
  const form     = document.getElementById("garage-form");
  const nameEl   = document.getElementById("garage-name");
  const floorsEl = document.getElementById("garage-floors");
  const rowsEl   = document.getElementById("garage-rows");
  const slotsEl  = document.getElementById("garage-slots");
  const listEl   = document.getElementById("garage-list");
  const msgEl    = document.getElementById("garage-msg");

  // Read-only map panel
  const mapCard    = document.getElementById("map-card");
  const mapTitle   = document.getElementById("map-title");
  const mapSummary = document.getElementById("map-summary");
  const mapGrid    = document.getElementById("map-grid");
  const mapMsg     = document.getElementById("map-msg");
  const mapAuto    = document.getElementById("map-auto");
  const mapZoom    = document.getElementById("map-zoom");

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
    listEl.innerHTML = data.map((g) => {
      const full = g.open_spots <= 0;
      const floorsTxt = g.floors && g.floors > 1 ? `${g.floors} floors · ` : "";
      const layout = g.rows && g.slots_per_row
        ? ` <span class="muted">· ${floorsTxt}${g.rows} rows × ${g.slots_per_row}</span>`
        : "";
      return `
        <li class="list-row">
          <span class="grow"><strong>${escapeHtml(g.name)}</strong>${layout}</span>
          <span class="badge ${full ? "badge-full" : ""}">
            ${g.open_spots}/${g.total_spots} open
          </span>
          <button class="btn btn-ghost map-view-btn" type="button" data-garage-id="${g.id}">View map</button>
        </li>`;
    }).join("");
  }

  // ---- Read-only live map panel ----
  async function renderMap() {
    if (mapGarageId == null) return;
    const myGen = ++mapGen;
    try {
      const { garage, bySpot } = await GarageMap.load(mapGarageId);
      if (myGen !== mapGen) return;  // a newer render started — drop this result
      mapSummary.textContent = `${garage.occupied} / ${garage.total_spots} occupied`;
      const drew = GarageMap.render(mapGrid, garage, bySpot);
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
    mapGrid.innerHTML = "";
    mapCard.classList.remove("hidden");
    mapCard.scrollIntoView({ behavior: "smooth", block: "start" });
    renderMap();
    syncMapAuto();
  }

  function closeMap() {
    if (mapAutoTimer) { clearInterval(mapAutoTimer); mapAutoTimer = null; }
    mapGen++;            // invalidate any in-flight renderMap so it can't paint the closed panel
    mapGarageId = null;
    mapGrid.innerHTML = "";
    mapCard.classList.add("hidden");
  }

  // ---- Events (bound once; list click is delegated so it survives re-render) ----
  listEl.addEventListener("click", (event) => {
    const btn = event.target.closest(".map-view-btn");
    if (btn) openMap(btn.dataset.garageId);
  });
  document.getElementById("map-refresh").addEventListener("click", renderMap);
  document.getElementById("map-close").addEventListener("click", closeMap);
  mapAuto.addEventListener("change", syncMapAuto);
  mapZoom.addEventListener("input", () => mapGrid.style.setProperty("--map-zoom", mapZoom.value));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    msgEl.textContent = "";

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

    const { error } = await sb
      .from("garages")
      .insert({
        owner_id: session.id,
        name,
        floors,
        rows,
        slots_per_row: slots,
        total_spots: floors * rows * slots,
      });

    if (error) { msgEl.textContent = error.message; return; }

    nameEl.value = "";
    floorsEl.value = "1";
    rowsEl.value = "4";
    slotsEl.value = "10";
    loadGarages();
  });

  loadGarages();
});
