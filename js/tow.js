// Tow company portal: pick a garage, see who is legally parked right now.
initPortal("tow", (session) => {
  const select   = document.getElementById("tow-garage");
  const plateEl  = document.getElementById("tow-plate");
  const rowsEl   = document.getElementById("tow-rows");
  const emptyEl  = document.getElementById("tow-empty");

  let parked = [];  // rows for the selected garage; filtered client-side by plate

  async function loadGarages() {
    const { data, error } = await sb.from("garages").select("id, name").order("name");
    if (error) { emptyEl.textContent = error.message; return; }

    select.innerHTML =
      `<option value="">— choose a garage —</option>` +
      data.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
  }

  async function loadParked(garageId) {
    parked = [];
    rowsEl.innerHTML = "";
    emptyEl.textContent = "";
    if (!garageId) return;

    const { data, error } = await sb
      .from("currently_parked")
      .select("*")
      .eq("garage_id", garageId)
      .order("spot_number");

    if (error) { emptyEl.textContent = error.message; return; }
    parked = data;
    renderRows();
  }

  // Show the loaded rows, filtered by the license-plate box (case-insensitive contains).
  function renderRows() {
    const q = plateEl.value.trim().toLowerCase();
    const filtered = q
      ? parked.filter((r) => r.license_plate.toLowerCase().includes(q))
      : parked;

    rowsEl.innerHTML = filtered.map((r) => `
      <tr>
        <td>${r.spot_number}</td>
        <td class="mono">${escapeHtml(r.license_plate)}</td>
        <td>${escapeHtml(r.color)} ${escapeHtml(r.make)} ${escapeHtml(r.model)}</td>
        <td>${new Date(r.parked_until).toLocaleString()}</td>
      </tr>`).join("");

    if (!select.value) {
      emptyEl.textContent = q ? "Choose a garage first to search." : "";
    } else if (!parked.length) {
      emptyEl.textContent = "No cars are currently parked in this garage.";
    } else if (!filtered.length) {
      emptyEl.textContent = `No parked car matches “${plateEl.value.trim()}”.`;
    } else {
      emptyEl.textContent = "";
    }
  }

  select.addEventListener("change", () => loadParked(select.value));
  plateEl.addEventListener("input", renderRows);
  document.getElementById("tow-refresh").addEventListener("click", () => loadParked(select.value));

  loadGarages();
});
