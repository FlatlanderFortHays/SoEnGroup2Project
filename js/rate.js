// Rate-your-stay page. Reached from a Past Stay in the user portal:
//   rate.html?role=user&reservation=<id>
// Resolves the session, verifies the stay belongs to this account and has ended, then
// upserts ONE review per reservation (garage_reviews.reservation_id is UNIQUE), so
// re-opening the page edits that stay's rating instead of adding a duplicate.
(function () {
  const params = new URLSearchParams(location.search);
  const role = params.get("role") || "user";
  const reservationId = Number(params.get("reservation"));
  const portal = role + ".html";
  const session = Auth.get(role);

  if (!session || session.role !== role) { location.href = portal; return; }

  const nameEl = document.getElementById("whoami-name");
  if (nameEl) nameEl.textContent = `${session.username} (${session.role})`;
  const back = document.getElementById("back-link");
  if (back) back.href = portal;
  const logout = document.getElementById("logout");
  if (logout) logout.addEventListener("click", () => { Auth.clear(role); location.href = portal; });

  const contextEl = document.getElementById("rate-context");
  const starsEl   = document.getElementById("stars");
  const starEls   = Array.from(starsEl.querySelectorAll(".star"));
  const labelEl   = document.getElementById("stars-label");
  const messageEl = document.getElementById("rate-message");
  const submitEl  = document.getElementById("rate-submit");
  const msgEl     = document.getElementById("rate-msg");

  let selected = 0;      // 0 = nothing chosen yet
  let garageId = null;

  const plural = (n) => `${n} star${n === 1 ? "" : "s"}`;

  // Fill stars up to n (hover preview or committed selection).
  function paint(n) {
    starEls.forEach((el) => {
      const on = Number(el.getAttribute("data-value")) <= n;
      el.classList.toggle("on", on);
      el.textContent = on ? "★" : "☆";
    });
  }
  starEls.forEach((el) => {
    const v = Number(el.getAttribute("data-value"));
    el.addEventListener("mouseenter", () => { paint(v); labelEl.textContent = plural(v); });
    el.addEventListener("click", () => { selected = v; paint(v); labelEl.textContent = `${plural(v)} selected`; });
  });
  starsEl.addEventListener("mouseleave", () => {
    paint(selected);
    labelEl.textContent = selected ? `${plural(selected)} selected` : "Hover the stars, then click to choose (1–5).";
  });

  function fail(text) { contextEl.className = "error"; contextEl.textContent = text; submitEl.disabled = true; }

  // Load the stay, verify it's this user's and has ended, and prefill any existing rating.
  (async () => {
    if (!reservationId) { fail("No stay specified."); return; }

    const { data: r, error } = await sb
      .from("reservations")
      .select("*, garages(name), cars(user_id)")
      .eq("id", reservationId)
      .maybeSingle();

    if (error) { fail(error.message); return; }
    if (!r || !r.cars || r.cars.user_id !== session.id) { fail("That stay isn't on your account."); return; }
    if (new Date(r.parked_until) >= new Date()) { fail("You can only rate a stay after it has ended."); return; }

    garageId = r.garage_id;
    const gname = (r.garages && r.garages.name) || `Garage #${r.garage_id}`;
    contextEl.className = "hint";
    contextEl.textContent =
      `${gname} · ${new Date(r.parked_at).toLocaleDateString()} – ${new Date(r.parked_until).toLocaleDateString()}`;

    const { data: existing } = await sb
      .from("garage_reviews")
      .select("rating, review")
      .eq("reservation_id", reservationId)
      .maybeSingle();
    if (existing) {
      selected = Number(existing.rating) || 0;
      paint(selected);
      if (selected) labelEl.textContent = `${plural(selected)} selected`;
      if (existing.review) messageEl.value = existing.review;
    }
  })();

  submitEl.addEventListener("click", async () => {
    msgEl.className = "msg";
    msgEl.textContent = "";
    if (!selected) { msgEl.className = "msg error"; msgEl.textContent = "Please pick 1–5 stars."; return; }
    if (garageId == null) { msgEl.className = "msg error"; msgEl.textContent = "Still loading — try again in a moment."; return; }

    submitEl.disabled = true;
    const { error } = await sb.from("garage_reviews").upsert({
      reservation_id: reservationId,
      garage_id: garageId,
      user_id: session.id,
      rating: selected,
      review: messageEl.value.trim() || null,
    }, { onConflict: "reservation_id" });
    submitEl.disabled = false;

    if (error) { msgEl.className = "msg error"; msgEl.textContent = error.message; return; }
    msgEl.className = "msg success";
    msgEl.textContent = "✅ Thanks! Your rating was saved. Returning…";
    setTimeout(() => { location.href = portal; }, 900);
  });
})();
