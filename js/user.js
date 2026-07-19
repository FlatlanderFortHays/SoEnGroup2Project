// User portal: manage cars, browse garages, park, and (for demos) fill a lot.
initPortal("user", (session) => {
  // Cars
  const carForm        = document.getElementById("car-form");
  const carList        = document.getElementById("car-list");
  const carMsg         = document.getElementById("car-msg");
  const carSelect      = document.getElementById("park-car");
  const carColorSelect = document.getElementById("car-color");

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
  const calcCostSpan        = document.getElementById("calc-cost");

  // Reservation Alteration Elements
  const myReservationsList = document.getElementById("my-reservations-list");
  const manageMsgEl = document.getElementById("manage-msg");

  let cars = [];

  // Garages are cached so the per-row price estimates can be re-rendered on every
  // keystroke in the Hours box without re-hitting the network.
  let garages = [];
  let garagesState = "loading";   // "loading" | "error" | "ready"
  let selectedGarageId = null;    // clicking a garage row prices the banner for it

  // The user's own bookings, kept so Extend can quote the added cost from each row's
  // snapshotted rates before committing anything.
  let myReservations = [];

  let warnedNoPricing = false;   // the "re-run schema.sql" nag fires at most once

  // Re-rendering the garage rows swaps out their DOM, which would replace the disabled
  // "Book spot" button mid-request with a fresh enabled one and let the booking be
  // submitted twice. Hold off re-rendering while a booking is in flight.
  let bookingInFlight = false;

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

    updateCostEstimate(hoursVal);

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

    const endDate = new Date(startDate.getTime() + Pricing.hoursToMinutes(hoursVal) * 60000);

    const options = {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    };

    if (calcStartSpan) calcStartSpan.textContent = startDate.toLocaleString([], options);
    if (calcEndSpan) calcEndSpan.textContent = endDate.toLocaleString([], options);
  }

  // The cost depends on the hours and the GARAGE — not on the booking type, and not on
  // a date being picked yet. Rates are per-garage, but a garage isn't chosen until the
  // user clicks a row below, so: show the selected garage's exact price once one is
  // picked, otherwise the range across the garages on offer. On a fresh database every
  // garage carries the same default rate card, so that range collapses to one number.
  function updateCostEstimate(hoursVal) {
    if (!calcCostSpan) return;

    if (!hoursVal) { calcCostSpan.textContent = "--"; return; }

    const selected = garages.find((g) => g.id === selectedGarageId);
    if (selected) {
      const q = Pricing.quote(selected, hoursVal);
      calcCostSpan.textContent =
        `${q.formatted} at ${selected.name}${q.capped ? " · daily cap applied" : ""}`;
      return;
    }

    if (!garages.length) { calcCostSpan.textContent = "--"; return; }

    const prices = garages.map((g) => Pricing.priceCents(g, Pricing.hoursToMinutes(hoursVal)));
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);

    calcCostSpan.textContent = lo === hi
      ? `${Pricing.formatCents(lo)} at any garage below`
      : `${Pricing.formatCents(lo)}–${Pricing.formatCents(hi)} — varies by garage; pick one below`;
  }

  // Fire updates whenever inputs scale or change values
  if (parkStartTimeInput) {
    parkStartTimeInput.addEventListener("input", updateCalculatedTimeline);
  }
  if (hoursEl) {
    hoursEl.addEventListener("input", () => {
      updateCalculatedTimeline();
      renderGarages();   // re-price the rows from cache — no network hit per keystroke
    });
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
            ${CarColors.swatchHtml(c.color)}
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
      // canonical() maps the chosen <option> back onto the exact stored form ('Navy') and
      // returns null for anything off-palette, so we can never POST a colour the database's
      // CHECK constraint would reject with a raw Postgres error.
      color:         CarColors.canonical(carColorSelect.value) || "",
      license_plate: document.getElementById("car-plate").value.trim(),
      size:          document.getElementById("car-size").value,
      is_ev:         document.getElementById("car-ev").checked,
    };
    if (!car.make || !car.model || !car.license_plate) {
      carMsg.textContent = "Please fill in the make, model and license plate.";
      return;
    }
    if (!car.color) {
      carMsg.textContent = "Please pick a color for the car.";
      return;
    }

    const { error } = await sb.from("cars").insert(car);
    if (error) {
      // 23514 = check_violation, i.e. cars_color_check: the colour isn't in the palette.
      carMsg.textContent = error.code === "23514"
        ? "Pick a color from the list (reload the page if you still see a text box)."
        : error.message;
      return;
    }

    carForm.reset();
    loadCars();
  });

  // ---- Garages / parking ----
  // Fetch is split from render so the per-garage price estimates can be recomputed on
  // every keystroke in the Hours box without another round-trip to the database.
  async function loadGarages() {
    const { data, error } = await sb
      .from("garage_availability").select("*").order("name");

    if (error) {
      garages = [];
      garagesState = "error";
      garageList.innerHTML = `<li class="error">${escapeHtml(error.message)}</li>`;
      updateCostEstimate(readHours());
      return;
    }

    garages = data;
    garagesState = "ready";

    // If the selected garage vanished (deleted, renamed away), drop the selection.
    if (selectedGarageId != null && !garages.some((g) => g.id === selectedGarageId)) {
      selectedGarageId = null;
    }

    // An un-migrated database returns no rate columns. Say so plainly rather than
    // quietly pricing everything at made-up defaults. Once only — loadGarages() re-runs
    // after every booking, and this must not stomp on the success message.
    if (!warnedNoPricing && garages.length && !garages.some((g) => Pricing.hasRates(g))) {
      warnedNoPricing = true;
      parkMsg("⚠️ This database is missing the pricing columns — re-run supabase/schema.sql. Prices shown are estimates.", true);
    }

    renderGarages();
    updateCostEstimate(readHours());   // rates only just arrived; price the banner now
  }

  function renderGarages() {
    if (garagesState !== "ready") return;   // don't clobber a loading/error message
    if (bookingInFlight) return;            // don't swap the in-flight button out from under us

    if (!garages.length) {
      garageList.innerHTML = `<li class="muted">No garages yet. Ask an owner to add one.</li>`;
      return;
    }

    const hours = readHours();
    const isFutureMode = bookingTypeSelect && bookingTypeSelect.value === "future";

    garageList.innerHTML = garages.map((g) => {
      const full = g.open_spots <= 0;
      const selected = g.id === selectedGarageId;
      const quote = hours ? Pricing.quote(g, hours) : null;

      const priceBadge = quote
        ? `<span class="badge" title="Estimated cost for ${escapeHtml(String(hours))}h">${quote.formatted}${quote.capped ? " · cap" : ""}</span>`
        : "";

      return `
        <li class="list-row garage-row${selected ? " is-selected" : ""}" data-garage="${g.id}">
          <span class="grow">
            <strong>${escapeHtml(g.name)}</strong>
            <br /><span class="muted">${escapeHtml(Pricing.rateCard(g))}</span>
          </span>
          ${priceBadge}
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

    // Clicking the row itself (not one of its buttons) selects that garage, which
    // prices the banner above for it.
    if (!parkId && !simId) {
      const row = event.target.closest(".garage-row");
      if (!row) return;
      const id = Number(row.dataset.garage);
      selectedGarageId = selectedGarageId === id ? null : id;
      renderGarages();
      updateCostEstimate(readHours());
      return;
    }

    const hours = readHours();
    if (!hours) { parkMsg("Enter a valid number of hours.", true); return; }

    event.target.disabled = true;
    bookingInFlight = true;
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
            // row.price is what the DB actually charged — show that, not our estimate.
            const cost = row.price != null ? ` — ${Pricing.money(row.price)}` : "";
            parkMsg(`✅ Parked in spot #${row.spot_number} until ${new Date(row.parked_until).toLocaleString()}${cost}`, false);
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
            const cost = row.price != null ? ` — ${Pricing.money(row.price)}` : "";

            parkMsg(`📅 Success! Spot #${displaySpot} is reserved for you from ${displayStart} until ${displayEnd}${cost}`, false);
          }
        }
      } else {
        // Simulation triggers.
        // p_colors (inside the helper) is the exact list the Color dropdown above offers, so
        // the cars the simulation invents and the cars a user can register are one palette.
        // count: null = fill ALL remaining spots (same call as js/simulation.js).
        const { data, error } = await CarColors.simulateFill(sb, {
          garageId: simId,
          count: null,
          hours,
        });
        if (error) parkMsg(error.message, true);
        else       parkMsg(`🧪 Simulated ${data} car(s) parking for ${hours}h.`, false);
      }
    } finally {
      event.target.disabled = false;
      bookingInFlight = false;
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

    // Fetch historical log entries associated with the authenticated account session.
    // "*" rather than an explicit column list: on a database that hasn't had the
    // pricing migration run yet, naming `price` here would turn this whole panel into
    // a raw "column does not exist" error and take Extend/Edit/Cancel down with it.
    const { data, error } = await sb
      .from("reservations")
      .select(`
        *,
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
    myReservations = validReservations;   // Extend prices its quote from these rows

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

      // The price stored on the booking — not a recomputation. It was locked in when
      // the driver booked, so it stays put even if the owner later changes their rates.
      // Rows created before pricing existed have no price; money() renders those as "—".
      const durationMins = Math.round((end - start) / 60000);
      const costLine = `💵 <strong>${Pricing.money(r.price)}</strong> for ${Pricing.formatHours(durationMins)}`;

      return `
        <li class="list-row" style="flex-direction: column; align-items: flex-start; gap: 0.5rem; padding: 1rem 0; border-bottom: 1px solid #eee;">
          <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
            <strong>${escapeHtml(r.garages.name)} — Spot #${r.spot_number}</strong>
            ${statusBadge}
          </div>
          <div class="grow muted">
            🚗 <span class="mono">${escapeHtml(r.cars.license_plate)}</span> (${escapeHtml(r.cars.make)} ${escapeHtml(r.cars.model)})<br>
            📅 ${start.toLocaleString()} to ${end.toLocaleString()}<br>
            ${costLine}
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

          // Quote the extension before committing it. The server re-prices the WHOLE
          // window (that's what keeps the daily cap honest), so the added cost is the
          // difference between the new total and what's already on the booking — which
          // is why extending into the cap can legitimately cost $0.00.
          const res = myReservations.find((r) => r.id === Number(resId));
          if (!res || res.price == null) {
            // Fail closed: never extend a booking we can't put a price on.
            manageMsg("⚠️ Couldn't price that extension right now, so nothing was changed. Refresh and try again.", true);
            return;
          }

          const totalMins =
            Math.round((new Date(res.parked_until) - new Date(res.parked_at)) / 60000)
            + Pricing.hoursToMinutes(hours);
          const rates = {
            first_hour_rate: res.rate_first_hour,
            hourly_rate:     res.rate_hourly,
            daily_cap:       res.rate_daily_cap,
          };
          const newTotal = Pricing.priceCents(rates, totalMins);
          const alreadyPaid = Math.round(Number(res.price) * 100);
          const added = Math.max(0, newTotal - alreadyPaid);

          const note = added === 0
            ? "\n\nYou've already hit the daily cap — these extra hours are free."
            : "";
          const ok = confirm(
            `Extend by ${hours}h?\n\n` +
            `Added cost: ${Pricing.formatCents(added)}\n` +
            `New total:  ${Pricing.formatCents(newTotal)}${note}`
          );
          if (!ok) return;

          const { data, error } = await sb.rpc("extend_current_reservation", {
            p_reservation_id: Number(resId),
            p_extra_hours: hours
          });

          if (error) manageMsg(error.message, true);
          else {
            const row = Array.isArray(data) ? data[0] : data;
            const cost = row.price != null ? ` — now ${Pricing.money(row.price)} total` : "";
            manageMsg(`✅ Stay extended successfully until ${new Date(row.parked_until).toLocaleString()}${cost}!`, false);
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

  // The Color dropdown IS the palette (js/carColors.js) — the same list the map paints from
  // and the same list we hand to simulate_fill().
  CarColors.fillSelect(carColorSelect);
  // ---------------- Contact Support ----------------

const supportSubject = document.getElementById("support-subject");
const supportMessage = document.getElementById("support-message");
const supportButton  = document.getElementById("support-submit");
const supportMsg     = document.getElementById("support-msg");

if (supportButton) {
  supportButton.addEventListener("click", async () => {

    supportMsg.textContent = "";

    const subject = supportSubject.value.trim();
    const message = supportMessage.value.trim();

    if (!subject || !message) {
      supportMsg.textContent = "Please complete all fields.";
      return;
    }

    const { error } = await sb
      .from("support_tickets")
      .insert({
        user_id: session.id,
        subject,
        message
      });

    if (error) {
      supportMsg.textContent = error.message;
      return;
    }

    supportSubject.value = "";
    supportMessage.value = "";

    supportMsg.textContent =
      "Support request submitted successfully.";
  // ---------------- Review System ----------------

const reviewGarage = document.getElementById("review-garage");
const reviewRating = document.getElementById("review-rating");
const reviewMessage = document.getElementById("review-message");
const reviewSubmit = document.getElementById("review-submit");
const reviewMsg = document.getElementById("review-msg");

// Load garages into the dropdown
(async () => {
  const { data } = await sb
    .from("garages")
    .select("id,name")
    .order("name");

  if (data && reviewGarage) {
    data.forEach(g => {
      const option = document.createElement("option");
      option.value = g.id;
      option.textContent = g.name;
      reviewGarage.appendChild(option);
    });
  }
})();

if (reviewSubmit) {
  reviewSubmit.addEventListener("click", async () => {

    reviewMsg.textContent = "";

    const { error } = await sb
      .from("garage_reviews")
      .insert({
        garage_id: Number(reviewGarage.value),
        user_id: session.id,
        rating: Number(reviewRating.value),
        review: reviewMessage.value.trim()
      });

    if (error) {
      reviewMsg.textContent = error.message;
      return;
    }

    reviewMessage.value = "";
    reviewRating.value = "5";

    reviewMsg.textContent =
      "Review submitted successfully.";
  });
}

  loadCars();
  loadGarages();
  loadUserReservations();
});
