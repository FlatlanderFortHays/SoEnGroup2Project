// Owner portal: create garages, see live occupancy.
initPortal("owner", (session) => {
  const form     = document.getElementById("garage-form");
  const nameEl   = document.getElementById("garage-name");
  const spotsEl  = document.getElementById("garage-spots");
  const listEl   = document.getElementById("garage-list");
  const msgEl    = document.getElementById("garage-msg");

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
    if (!data.length) {
      listEl.innerHTML = `<li class="muted">No garages yet — add one above.</li>`;
      return;
    }
    listEl.innerHTML = data.map((g) => {
      const full = g.open_spots <= 0;
      return `
        <li class="list-row">
          <span class="grow"><strong>${escapeHtml(g.name)}</strong></span>
          <span class="badge ${full ? "badge-full" : ""}">
            ${g.open_spots}/${g.total_spots} open
          </span>
        </li>`;
    }).join("");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    msgEl.textContent = "";

    const name  = nameEl.value.trim();
    const total = parseInt(spotsEl.value, 10);
    if (!name || !Number.isInteger(total) || total < 1) {
      msgEl.textContent = "Enter a name and at least 1 spot.";
      return;
    }

    const { error } = await sb
      .from("garages")
      .insert({ owner_id: session.id, name, total_spots: total });

    if (error) { msgEl.textContent = error.message; return; }

    nameEl.value = "";
    spotsEl.value = "10";
    loadGarages();
  });

  loadGarages();
});
