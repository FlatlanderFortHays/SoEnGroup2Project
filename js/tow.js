// Tow company portal: pick a garage, see who is legally parked right now.
initPortal("tow", (session) => {
  const select   = document.getElementById("tow-garage");
  const rowsEl   = document.getElementById("tow-rows");
  const emptyEl  = document.getElementById("tow-empty");

  async function loadGarages() {
    const { data, error } = await sb.from("garages").select("id, name").order("name");
    if (error) { emptyEl.textContent = error.message; return; }

    select.innerHTML =
      `<option value="">— choose a garage —</option>` +
      data.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
  }

  async function loadParked(garageId) {
    rowsEl.innerHTML = "";
    emptyEl.textContent = "";
    if (!garageId) return;

    const { data, error } = await sb
      .from("currently_parked")
      .select("*")
      .eq("garage_id", garageId)
      .order("spot_number");

    if (error) { emptyEl.textContent = error.message; return; }
    if (!data.length) {
      emptyEl.textContent = "No cars are currently parked in this garage.";
      return;
    }

    rowsEl.innerHTML = data.map((r) => `
      <tr>
        <td>${r.spot_number}</td>
        <td class="mono">${escapeHtml(r.license_plate)}</td>
        <td>${escapeHtml(r.color)} ${escapeHtml(r.make)} ${escapeHtml(r.model)}</td>
        <td>${new Date(r.parked_until).toLocaleString()}</td>
      </tr>`).join("");
  }

  select.addEventListener("change", () => loadParked(select.value));
  document.getElementById("tow-refresh").addEventListener("click", () => loadParked(select.value));

  loadGarages();
});
