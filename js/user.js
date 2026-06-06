// User portal: manage cars, browse garages, park, and (for demos) fill a lot.
initPortal("user", (session) => {
  // Cars
  const carForm   = document.getElementById("car-form");
  const carList   = document.getElementById("car-list");
  const carMsg    = document.getElementById("car-msg");
  const carSelect = document.getElementById("park-car");

  // Parking
  const garageList = document.getElementById("garage-list");
  const hoursEl    = document.getElementById("park-hours");
  const parkMsgEl  = document.getElementById("park-msg");

  let cars = [];

  function parkMsg(text, isError) {
    parkMsgEl.textContent = text;
    parkMsgEl.className = "msg " + (isError ? "error" : "success");
  }

  function readHours() {
    const h = parseFloat(hoursEl.value);
    return Number.isFinite(h) && h > 0 ? h : null;
  }

  // ---- Cars ----
  async function loadCars() {
    const { data, error } = await sb
      .from("cars").select("*").eq("user_id", session.id).order("id");

    if (error) {
      carList.innerHTML = `<li class="error">${escapeHtml(error.message)}</li>`;
      return;
    }
    cars = data;

    carList.innerHTML = data.length
      ? data.map((c) => `
          <li class="list-row">
            <span class="mono">${escapeHtml(c.license_plate)}</span>
            <span class="grow">${escapeHtml(c.color)} ${escapeHtml(c.make)} ${escapeHtml(c.model)}</span>
          </li>`).join("")
      : `<li class="muted">No cars yet — add one above.</li>`;

    carSelect.innerHTML = data.length
      ? data.map((c) =>
          `<option value="${c.id}">${escapeHtml(c.license_plate)} — ${escapeHtml(c.make)} ${escapeHtml(c.model)}</option>`
        ).join("")
      : `<option value="">(add a car first)</option>`;
  }

  carForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    carMsg.textContent = "";

    const car = {
      user_id:       session.id,
      make:          document.getElementById("car-make").value.trim(),
      model:         document.getElementById("car-model").value.trim(),
      color:         document.getElementById("car-color").value.trim(),
      license_plate: document.getElementById("car-plate").value.trim(),
    };
    if (!car.make || !car.model || !car.color || !car.license_plate) {
      carMsg.textContent = "Please fill in all four car fields.";
      return;
    }

    const { error } = await sb.from("cars").insert(car);
    if (error) { carMsg.textContent = error.message; return; }

    carForm.reset();
    loadCars();
  });

  // ---- Garages / parking ----
  async function loadGarages() {
    const { data, error } = await sb
      .from("garage_availability").select("*").order("name");

    if (error) {
      garageList.innerHTML = `<li class="error">${escapeHtml(error.message)}</li>`;
      return;
    }
    if (!data.length) {
      garageList.innerHTML = `<li class="muted">No garages yet. Ask an owner to add one.</li>`;
      return;
    }

    garageList.innerHTML = data.map((g) => {
      const full = g.open_spots <= 0;
      return `
        <li class="list-row">
          <span class="grow"><strong>${escapeHtml(g.name)}</strong></span>
          <span class="badge ${full ? "badge-full" : ""}">${g.open_spots}/${g.total_spots} open</span>
          <button class="btn" data-park="${g.id}" ${full ? "disabled" : ""}>Park now</button>
          <button class="btn btn-ghost" data-sim="${g.id}" title="Demo: instantly fill the lot">Simulate full lot</button>
        </li>`;
    }).join("");
  }

  garageList.addEventListener("click", async (event) => {
    const parkId = event.target.getAttribute("data-park");
    const simId  = event.target.getAttribute("data-sim");
    if (!parkId && !simId) return;

    const hours = readHours();
    if (!hours) { parkMsg("Enter a valid number of hours.", true); return; }

    event.target.disabled = true;
    try {
      if (parkId) {
        if (!cars.length) { parkMsg("Add a car first (above).", true); return; }
        const carId = parseInt(carSelect.value, 10);

        const { data, error } = await sb.rpc("park_car", {
          p_garage_id: Number(parkId),
          p_car_id: carId,
          p_hours: hours,
        });
        if (error) {
          // park_car (supabase/schema.sql) raises exactly "No spots available"
          // and "This car is already parked" — keep these patterns in sync with it.
          let msg = error.message;
          if (/no spots/i.test(msg)) msg = "🚫 No spots available";
          else if (/already parked/i.test(msg)) msg = "⚠️ That car is already parked.";
          parkMsg(msg, true);
        } else {
          const row = Array.isArray(data) ? data[0] : data;
          parkMsg(`✅ Parked in spot #${row.spot_number} until ${new Date(row.parked_until).toLocaleString()}`, false);
        }
      } else {
        // p_count: null = fill ALL remaining spots. (Supabase matches RPC args by
        // name, so this is the same as omitting it — just explicit for clarity.)
        const { data, error } = await sb.rpc("simulate_fill", {
          p_garage_id: Number(simId),
          p_count: null,
          p_hours: hours,
        });
        if (error) parkMsg(error.message, true);
        else       parkMsg(`🧪 Simulated ${data} car(s) parking for ${hours}h.`, false);
      }
    } finally {
      event.target.disabled = false;
      loadGarages();
    }
  });

  loadCars();
  loadGarages();
});
