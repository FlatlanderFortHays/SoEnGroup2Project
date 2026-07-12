// Garage Simulation: a public, login-free live map of one garage's spots.
// Empty vs Occupied only — a spot is "occupied" exactly while a reservation's
// parked_until is in the future (same rule the rest of the app uses), so the
// `currently_parked` view already tells us which spots are taken.
// The drawing is delegated to the shared js/garageMap.js (also used by the owner
// portal) so both views render identically.
(function () {
  const select    = document.getElementById("sim-garage");
  const summaryEl = document.getElementById("sim-summary");
  const msgEl     = document.getElementById("sim-msg");
  const hoursEl   = document.getElementById("sim-hours");
  const autoEl    = document.getElementById("sim-auto");
  const zoomEl    = document.getElementById("sim-zoom");
  const fillBtn   = document.getElementById("sim-fill");
  const clearBtn  = document.getElementById("sim-clear");

  // The canvas map controller (renders the lot, owns pan/zoom/tooltip/floors).
  const map = GarageMap.mount(document.getElementById("sim-viewport"), {
    onZoomChange: (z) => { zoomEl.value = z; },
  });

  let autoTimer = null;
  let gen = 0;  // race guard: a slow fetch is dropped if a newer render started

  function msg(text, isError) {
    msgEl.textContent = text;
    msgEl.className = "msg " + (isError ? "error" : "success");
  }

  // Same validation rule as readHours() in js/user.js.
  function readHours() {
    const h = parseFloat(hoursEl.value);
    return Number.isFinite(h) && h > 0 ? h : null;
  }

  async function loadGarages() {
    const { data, error } = await sb
      .from("garage_availability").select("id, name, total_spots").order("name");
    if (error) { msg(error.message, true); return; }

    select.innerHTML =
      `<option value="">— choose a garage —</option>` +
      data.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
  }

  // Fetch the garage's live state and paint it via the shared renderer.
  async function render() {
    const myGen = ++gen;  // bump first so any prior in-flight fetch is invalidated
    const garageId = select.value;
    if (!garageId) { map.clear(); summaryEl.textContent = ""; return; }

    try {
      const { garage, bySpot } = await GarageMap.load(garageId);
      if (myGen !== gen) return;  // a newer render started — drop this result
      summaryEl.textContent = `${garage.occupied} / ${garage.total_spots} occupied`;
      const drew = map.setData(garage, bySpot);
      if (!drew && autoEl.checked) { autoEl.checked = false; syncAutoRefresh(); }
      msg("");
    } catch (err) {
      if (myGen !== gen) return;
      if (err.code === "GM_NOT_FOUND") {
        map.clear(); summaryEl.textContent = "";
        syncAutoRefresh(); loadGarages();
        msg("This garage is no longer available.", true);
      } else {
        msg(err.message || String(err), true);
      }
    }
  }

  // Re-arm the auto-refresh timer based on the checkbox + current selection.
  function syncAutoRefresh() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (autoEl.checked && select.value) {
      autoTimer = setInterval(render, 5000);
    }
  }

  select.addEventListener("change", () => { msg(""); render(); syncAutoRefresh(); });
  document.getElementById("sim-refresh").addEventListener("click", render);
  autoEl.addEventListener("change", syncAutoRefresh);
  zoomEl.addEventListener("input", () => map.setZoom(zoomEl.value));

  // Fill every open spot with simulated cars (reuses the simulate_fill RPC).
  fillBtn.addEventListener("click", async () => {
    const garageId = select.value;
    if (!garageId) { msg("Pick a garage first.", true); return; }
    const hours = readHours();
    if (!hours) { msg("Enter a valid number of hours.", true); return; }

    fillBtn.disabled = true;
    try {
      // p_count: null = fill ALL remaining spots (same call as js/user.js).
      const { data, error } = await sb.rpc("simulate_fill", {
        p_garage_id: Number(garageId),
        p_count: null,
        p_hours: hours,
      });
      if (error) msg(error.message, true);
      else       msg(`🧪 Simulated ${data} car(s) parking for ${hours}h.`, false);
    } finally {
      fillBtn.disabled = false;
      render();
    }
  });

  // Remove ONLY simulated cars so a demo can be reset. Real reservations stay.
  clearBtn.addEventListener("click", async () => {
    const garageId = select.value;
    if (!garageId) { msg("Pick a garage first.", true); return; }

    clearBtn.disabled = true;
    try {
      const { error } = await sb
        .from("reservations").delete()
        .eq("garage_id", Number(garageId))
        .eq("is_simulated", true);
      if (error) msg(error.message, true);
      else       msg("🧹 Cleared simulated cars.", false);
    } finally {
      clearBtn.disabled = false;
      render();
    }
  });

  loadGarages();
})();
