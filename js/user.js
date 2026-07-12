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

  // Future Booking Elements
  const bookingTypeSelect   = document.getElementById("booking-type");
  const futureDateContainer = document.getElementById("future-date-container");
  const parkStartTimeInput  = document.getElementById("park-start-time");
  const calcStartSpan       = document.getElementById("calc-start");
  const calcEndSpan         = document.getElementById("calc-end");

  // Reservation Alteration Elements
  const myReservationsList = document.getElementById("my-reservations-list");
  const manageMsgEl = document.getElementById("manage-msg");

  let cars = [];

  // Initialize input parameters with current local calendar constraints
  if (parkStartTimeInput) {
    const now = new Date();
    const localISOTime = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    parkStartTimeInput.min = localISOTime;
    parkStartTimeInput.value = localISOTime;
  }

  // Toggle visual input wrappers matching project toggle patterns
  if (bookingTypeSelect && futureDateContainer) {
    bookingTypeSelect.addEventListener("change", () => {
      if (bookingTypeSelect.value === "future") {
        futureDateContainer.classList.remove("hidden");
      } else {
        futureDateContainer.classList.add("hidden");
      }
      updateCalculatedTimeline();
    });
  }

  // Recalculates departure timestamps locally in real time
  function updateCalculatedTimeline() {
    if (!bookingTypeSelect || !hoursEl) return;
    
    const bookingType = bookingTypeSelect.value;
    const hoursVal = readHours();

    if (!hoursVal) {
      if (calcStartSpan) calcStartSpan.textContent = "--";
      if (calcEndSpan) calcEndSpan.textContent = "--";
      return;
    }

    let startDate;

    if (bookingType === "now") {
      startDate = new Date(); 
    } else if (bookingType === "future" && parkStartTimeInput && parkStartTimeInput.value) {
      startDate = new Date(parkStartTimeInput.value); 
    } else {
      if (calcStartSpan) calcStartSpan.textContent = "--";
      if (calcEndSpan) calcEndSpan.textContent = "--";
      return;
    }

    const endDate = new Date(startDate.getTime() + Math.round(hoursVal * 60) * 60000);

    const options = { 
      month: 'short', 
      day: 'numeric', 
      hour: 'numeric', 
      minute: '2-digit' 
    };

    if (calcStartSpan) calcStartSpan.textContent = startDate.toLocaleString([], options);
    if (calcEndSpan) calcEndSpan.textContent = endDate.toLocaleString([], options);
  }

  // Fire updates whenever inputs scale or change values
  if (parkStartTimeInput) {
    parkStartTimeInput.addEventListener("input", updateCalculatedTimeline);
  }
  if (hoursEl) {
    hoursEl.addEventListener("input", updateCalculatedTimeline);
  }

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
      size:          document.getElementById("car-size").value,
      is_ev:         document.getElementById("car-ev").checked,
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
      const isFutureMode = bookingTypeSelect && bookingTypeSelect.value === "future";
      
      return `
        <li class="list-row">
          <span class="grow"><strong>${escapeHtml(g.name)}</strong></span>
          <span class="badge ${full && !isFutureMode ? "badge-full" : ""}">${g.open_spots}/${g.total_spots} open now</span>
          <button class="btn" data-park="${g.id}">Book spot</button>
          <button class="btn btn-ghost" data-sim="${g.id}" title="Demo: instantly fill the lot">Simulate full lot</button>
        </li>`;
    }).join("");
  }

  if (bookingTypeSelect) {
    bookingTypeSelect.addEventListener("change", loadGarages);
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
        const bookingType = bookingTypeSelect ? bookingTypeSelect.value : "";

        if (bookingType === "") {
          parkMsg("⚠️ Please select a Booking Type first.", true);
          return;
        }

        if (bookingType === "now") {
          // Route 1: Call Immediate Parking Routine
          const { data, error } = await sb.rpc("park_car", {
            p_garage_id: Number(parkId),
            p_car_id: carId,
            p_hours: hours,
          });
          if (error) {
            let msg = error.message;
            if (/no spots/i.test(msg)) msg = "🚫 No spots available right now.";
            else if (/already parked/i.test(msg)) msg = "⚠️ That car is already parked.";
            parkMsg(msg, true);
          } else {
            const row = Array.isArray(data) ? data[0] : data;
            parkMsg(`✅ Parked in spot #${row.spot_number} until ${new Date(row.parked_until).toLocaleString()}`, false);
          }
        } else if (bookingType === "future") {
          // Route 2: Call Planned Future Reservation Engine
          const selectedTime = parkStartTimeInput.value;
          if (!selectedTime) {
            parkMsg("Please pick a future arrival date.", true);
            return;
          }
          const startTimestampISO = new Date(selectedTime).toISOString();

          const { data, error } = await sb.rpc("reserve_car", {
            p_garage_id: Number(parkId),
            p_car_id: carId,
            p_start: startTimestampISO,
            p_hours: hours,
          });

          if (error) {
            let msg = error.message;
            if (/no spots/i.test(msg)) msg = "🚫 No spots available for that specific time window.";
            else if (/already has a reservation/i.test(msg)) msg = "⚠️ This car already has a booking during that timeframe.";
            parkMsg(msg, true);
          } else {
            const row = Array.isArray(data) ? data[0] : data;

            if (!row) {
              parkMsg("⚠️ Reservation created but data payload failed to return.", true);
              return;
            }

            const displaySpot  = row.spot_number;
            const displayStart = new Date(row.parked_at).toLocaleString();
            const displayEnd   = new Date(row.parked_until).toLocaleString();

            parkMsg(`📅 Success! Spot #${displaySpot} is reserved for you from ${displayStart} until ${displayEnd}`, false);
          }
        }
      } else {
        // Simulation triggers
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
      updateCalculatedTimeline();
      loadGarages();
      loadUserReservations(); // Automatically refresh reservations list after booking
    }
  });

    // ---- Manage Reservations Operational Elements ----
  function manageMsg(text, isError) {
    if (!manageMsgEl) return;
    manageMsgEl.textContent = text;
    manageMsgEl.className = "msg " + (isError ? "error" : "success");
  }

  async function loadUserReservations() {
    if (!myReservationsList) return;

    // Fetch historical log entries associated with the authenticated account session
    const { data, error } = await sb
      .from("reservations")
      .select(`
        id, spot_number, parked_at, parked_until, is_simulated,
        garages(name),
        cars(license_plate, make, model, user_id)
      `)
      .order("parked_at", { ascending: true });

    if (error) {
      myReservationsList.innerHTML = `<li class="error">${escapeHtml(error.message)}</li>`;
      return;
    }

    // Filter to ensure we only display records matching current logged-in user profile identity session
    const validReservations = data.filter(r => r.cars && r.cars.user_id === session.id && r.garages);

    if (!validReservations.length) {
      myReservationsList.innerHTML = `<li class="muted">You have no active or scheduled bookings.</li>`;
      return;
    }

    const now = new Date();

    myReservationsList.innerHTML = validReservations.map((r) => {
      const start = new Date(r.parked_at);
      const end = new Date(r.parked_until);
      const isPast = end < now;
      const isActiveNow = start <= now && end >= now;
      
      let statusBadge = `<span class="badge">Scheduled</span>`;
      let actionControls = `
        <button class="btn btn-ghost" data-action="edit-future" data-id="${r.id}">Edit</button>
        <button class="btn btn-danger" data-action="cancel" data-id="${r.id}" style="background:#cc0000; color:#fff; border:none; padding:0.25rem 0.5rem; cursor:pointer;">Cancel</button>
      `;

      if (isPast) {
        statusBadge = `<span class="badge muted">Past Stay</span>`;
        actionControls = `<span class="muted">None</span>`;
      } else if (isActiveNow) {
        statusBadge = `<span class="badge badge-full" style="background:#0088cc; color:#fff;">Active Now</span>`;
        actionControls = `<button class="btn" data-action="extend" data-id="${r.id}">Extend Stay</button>`;
      }

      return `
        <li class="list-row" style="flex-direction: column; align-items: flex-start; gap: 0.5rem; padding: 1rem 0; border-bottom: 1px solid #eee;">
          <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
            <strong>${escapeHtml(r.garages.name)} — Spot #${r.spot_number}</strong>
            ${statusBadge}
          </div>
          <div class="grow muted text-s">
            🚗 <span class="mono">${escapeHtml(r.cars.license_plate)}</span> (${escapeHtml(r.cars.make)} ${escapeHtml(r.cars.model)})<br>
            📅 ${start.toLocaleString()} to ${end.toLocaleString()}
          </div>
          <div style="display: flex; gap: 0.5rem; margin-top: 0.25rem;">
            ${actionControls}
          </div>
        </li>`;
    }).join("");
  }

  setTimeout(() => { loadUserReservations(); }, 500);

  if (myReservationsList) {
    myReservationsList.addEventListener("click", async (event) => {
      const action = event.target.getAttribute("data-action");
      const resId = event.target.getAttribute("data-id");
      if (!action || !resId) return;

      event.target.disabled = true;
      try {
        if (action === "cancel") {
          if (!confirm("Are you sure you want to cancel this reservation?")) return;
          
          const { error } = await sb.rpc("cancel_reservation", { p_reservation_id: Number(resId) });
          if (error) manageMsg(error.message, true);
          else {
            manageMsg("✅ Reservation successfully canceled.", false);
            loadUserReservations();
            loadGarages();
          }
        }

        if (action === "extend") {
          const extra = prompt("How many additional hours would you like to add to your current stay?", "1");
          const hours = parseFloat(extra);
          if (!hours || hours <= 0) return;

          const { data, error } = await sb.rpc("extend_current_reservation", {
            p_reservation_id: Number(resId),
            p_extra_hours: hours
          });

          if (error) manageMsg(error.message, true);
          else {
            const row = Array.isArray(data) ? data[0] : data;
            manageMsg(`✅ Stay extended successfully until ${new Date(row.parked_until).toLocaleString()}!`, false);
            loadUserReservations();
          }
        }

        if (action === "edit-future") {
          const newDateStr = prompt("Enter new Arrival Date & Time (YYYY-MM-DD HH:MM):");
          if (!newDateStr) return;
          const newHoursStr = prompt("Enter new duration in hours:", "2");
          const newHours = parseFloat(newHoursStr);

          const parsedDate = new Date(newDateStr);
          if (isNaN(parsedDate.getTime()) || !newHours || newHours <= 0) {
            manageMsg("⚠️ Invalid date format or duration value entered.", true);
            return;
          }

          const { data, error } = await sb.rpc("edit_future_reservation", {
            p_reservation_id: Number(resId),
            p_new_start: parsedDate.toISOString(),
            p_new_hours: newHours
          });

          if (error) manageMsg(error.message, true);
          else {
            const row = Array.isArray(data) ? data[0] : data;
            manageMsg(`✅ Reservation relocated successfully to Spot #${row.spot_number}!`, false);
            loadUserReservations();
            loadGarages();
          }
        }
      } finally {
        if (event.target) event.target.disabled = false;
      }
    });
  }

  loadCars();
  loadGarages();
  loadUserReservations();
});
