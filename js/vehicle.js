// Add / Edit / Remove a vehicle. Reached from the user portal's "My Vehicles" card:
//   vehicle.html?role=user            -> Add
//   vehicle.html?role=user&car=<id>   -> Edit (+ Remove)
// Session-gated like support.js/rate.js; reuses CarColors for the colour <select> and the
// live tinted preview. The cars table is permissive (mvp all access) so insert/update/delete
// all work with the anon key; deleting a car cascades to its reservations (schema FK).
(function () {
  const params = new URLSearchParams(location.search);
  const role = params.get("role") || "user";
  const carId = params.get("car") ? Number(params.get("car")) : null;
  const portal = role + ".html";
  const session = Auth.get(role);

  if (!session || session.role !== role) { location.href = portal; return; }

  const nameEl = document.getElementById("whoami-name");
  if (nameEl) nameEl.textContent = `${session.username} (${session.role})`;
  const back = document.getElementById("back-link");
  if (back) back.href = portal;
  const logout = document.getElementById("logout");
  if (logout) logout.addEventListener("click", () => { Auth.clear(role); location.href = portal; });

  const titleEl   = document.getElementById("veh-title");
  const makeEl    = document.getElementById("veh-make");
  const modelEl   = document.getElementById("veh-model");
  const colorEl   = document.getElementById("veh-color");
  const plateEl   = document.getElementById("veh-plate");
  const sizeEl    = document.getElementById("veh-size");
  const evEl      = document.getElementById("veh-ev");
  const submitEl  = document.getElementById("veh-submit");
  const removeEl  = document.getElementById("veh-remove");
  const msgEl     = document.getElementById("veh-msg");
  const prevCar   = document.getElementById("veh-preview-car");
  const prevPlate = document.getElementById("veh-preview-plate");

  CarColors.fillSelect(colorEl);

  function renderPreview() {
    prevCar.innerHTML = CarColors.carSvg(colorEl.value, sizeEl.value);
    const plate = (plateEl.value || "").trim().toUpperCase();
    prevPlate.textContent = plate || "PLATE";
  }
  [colorEl, sizeEl, plateEl].forEach((el) => {
    el.addEventListener("input", renderPreview);
    el.addEventListener("change", renderPreview);
  });

  function setMsg(text, isError) {
    msgEl.className = "msg " + (isError ? "error" : "success");
    msgEl.textContent = text;
  }

  // --- Edit mode: load the vehicle and prefill ---
  if (carId != null) {
    titleEl.textContent = "Edit Vehicle";
    submitEl.textContent = "Save changes";
    removeEl.classList.remove("hidden");

    (async () => {
      const { data: car, error } = await sb
        .from("cars").select("*").eq("id", carId).maybeSingle();
      if (error) { setMsg(error.message, true); return; }
      if (!car || car.user_id !== session.id) { location.href = portal; return; }  // not yours
      makeEl.value = car.make || "";
      modelEl.value = car.model || "";
      CarColors.fillSelect(colorEl, car.color);   // preselect the stored colour
      plateEl.value = car.license_plate || "";
      sizeEl.value = car.size || "normal";
      evEl.checked = !!car.is_ev;
      renderPreview();
    })();
  } else {
    renderPreview();
  }

  // --- Save (add or update) ---
  submitEl.addEventListener("click", async () => {
    setMsg("", false);
    const rec = {
      make: makeEl.value.trim(),
      model: modelEl.value.trim(),
      // canonical() maps the chosen option to the exact stored form ('Navy') and returns null
      // for anything off-palette, so we never POST a colour cars_color_check would reject.
      color: CarColors.canonical(colorEl.value) || "",
      license_plate: plateEl.value.trim(),
      size: sizeEl.value,
      is_ev: evEl.checked,
    };
    if (!rec.make || !rec.model || !rec.license_plate) {
      setMsg("Please fill in the make, model and license plate.", true);
      return;
    }
    if (!rec.color) { setMsg("Please pick a color.", true); return; }

    submitEl.disabled = true;
    let error;
    if (carId != null) {
      ({ error } = await sb.from("cars").update(rec).eq("id", carId));
    } else {
      ({ error } = await sb.from("cars").insert({ user_id: session.id, ...rec }));
    }
    submitEl.disabled = false;

    if (error) {
      setMsg(error.code === "23514" ? "Pick a color from the list." : error.message, true);
      return;
    }
    location.href = portal;   // back to My Vehicles
  });

  // --- Remove (edit mode only) ---
  removeEl.addEventListener("click", async () => {
    if (!confirm("Remove this vehicle? This also deletes its booking history.")) return;
    removeEl.disabled = true;
    const { error } = await sb.from("cars").delete().eq("id", carId);
    removeEl.disabled = false;
    if (error) { setMsg(error.message, true); return; }
    location.href = portal;
  });
})();
