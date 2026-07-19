// Dev console: review support tickets, run simulations + self-tests, and see
// site-level stats. Reuses the shared auth (initPortal / Auth) from supabaseClient.js.
// The page is hidden — nothing links to it — and gated by a real dev login, but with the
// public anon key + permissive RLS it's an honor-system console, not a hard boundary.

// ---- Create a dev account (login screen) ------------------------------------
// signup.html deliberately doesn't offer 'dev' (that would un-hide the console), so dev
// accounts are created here via the shared Auth.signup with role 'dev'. On success the
// session is stored; reloading lets initPortal("dev") resume straight into the console.
const devCreateBtn = document.getElementById("dev-create");
if (devCreateBtn) {
  devCreateBtn.addEventListener("click", async () => {
    const username = document.getElementById("dev-new-username").value;
    const password = document.getElementById("dev-new-password").value;
    const msg = document.getElementById("dev-create-msg");
    msg.className = "msg";
    msg.textContent = "";
    devCreateBtn.disabled = true;
    try {
      await Auth.signup(username, password, "dev");
      msg.className = "msg success";
      msg.textContent = "✅ Dev account created — signing you in…";
      location.reload();
    } catch (err) {
      msg.className = "msg error";
      msg.textContent = err.message || String(err);
    } finally {
      devCreateBtn.disabled = false;
    }
  });
}

// ---- The console ------------------------------------------------------------
initPortal("dev", (session) => {
  const STATUSES = ["Open", "In Progress", "Resolved", "Closed"];

  // --- Site overview ---
  const statsEl = document.getElementById("dev-stats");

  async function loadStats() {
    statsEl.innerHTML = `<p class="muted">Loading…</p>`;
    const { data, error } = await sb.rpc("dev_stats");
    if (error) {
      statsEl.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
      return;
    }
    const s = data || {};
    const acc = s.accounts || {};
    const res = s.reservations || {};
    const tix = s.tickets || {};
    const rev = s.reviews || {};
    const tile = (label, value) =>
      `<div class="stat-tile"><span class="stat-value">${escapeHtml(String(value))}</span><span class="stat-label">${escapeHtml(label)}</span></div>`;
    statsEl.innerHTML = `
      <div class="stat-grid">
        ${tile("Users", acc.user || 0)}
        ${tile("Owners", acc.owner || 0)}
        ${tile("Tow cos", acc.tow || 0)}
        ${tile("Devs", acc.dev || 0)}
        ${tile("Garages", s.garages || 0)}
        ${tile("Total spots", s.total_spots || 0)}
        ${tile("Cars", s.cars || 0)}
        ${tile("Active bookings", res.active || 0)}
        ${tile("Upcoming", res.upcoming || 0)}
        ${tile("Open tickets", tix["Open"] || 0)}
        ${tile("Reviews", rev.count || 0)}
        ${tile("Avg rating", rev.avg_rating == null ? "—" : rev.avg_rating)}
      </div>`;
  }

  // --- Support tickets ---
  const ticketsEl  = document.getElementById("dev-tickets");
  const ticketsMsg = document.getElementById("tickets-msg");

  async function loadTickets() {
    ticketsEl.innerHTML = `<p class="muted">Loading…</p>`;
    const { data, error } = await sb
      .from("support_tickets")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      ticketsEl.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
      return;
    }
    if (!data.length) {
      ticketsEl.innerHTML = `<p class="muted">No support tickets yet.</p>`;
      return;
    }
    ticketsEl.innerHTML = data.map((t) => {
      const opts = STATUSES.map(
        (st) => `<option value="${st}"${st === t.status ? " selected" : ""}>${st}</option>`
      ).join("");
      const who  = `${escapeHtml(t.username || "—")} (${escapeHtml(t.role || "—")})`;
      const when = t.created_at ? new Date(t.created_at).toLocaleString() : "";
      return `
        <div class="ticket">
          <div class="ticket-head">
            <strong>#${t.id} · ${escapeHtml(t.subject)}</strong>
            <select class="status-select" data-id="${t.id}">${opts}</select>
          </div>
          <div class="ticket-meta">from ${who} · ${escapeHtml(when)}</div>
          <div class="ticket-body">${escapeHtml(t.message)}</div>
        </div>`;
    }).join("");
  }

  // Update status inline (event delegation — rows are re-rendered on refresh).
  ticketsEl.addEventListener("change", async (event) => {
    const sel = event.target;
    if (!sel.classList || !sel.classList.contains("status-select")) return;
    const id = Number(sel.getAttribute("data-id"));
    ticketsMsg.className = "msg";
    ticketsMsg.textContent = "";
    sel.disabled = true;
    const { error } = await sb.from("support_tickets").update({ status: sel.value }).eq("id", id);
    sel.disabled = false;
    if (error) {
      ticketsMsg.className = "msg error";
      ticketsMsg.textContent = error.message;
    } else {
      ticketsMsg.className = "msg success";
      ticketsMsg.textContent = `Ticket #${id} → ${sel.value}`;
      loadStats();   // ticket-status counts changed
    }
  });

  // --- Simulations ---
  const simGarage = document.getElementById("sim-garage");
  const simCount  = document.getElementById("sim-count");
  const simHours  = document.getElementById("sim-hours");
  const simRun    = document.getElementById("sim-run");
  const simMsg    = document.getElementById("sim-msg");

  async function loadGaragesForSim() {
    const { data, error } = await sb.from("garages").select("id,name").order("name");
    if (error) {
      simMsg.className = "msg error";
      simMsg.textContent = error.message;
      return;
    }
    simGarage.innerHTML = data.length
      ? data.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("")
      : `<option value="">(no garages yet — add one in the owner portal)</option>`;
  }

  simRun.addEventListener("click", async () => {
    simMsg.className = "msg";
    simMsg.textContent = "";
    const garageId = simGarage.value;
    if (!garageId) {
      simMsg.className = "msg error";
      simMsg.textContent = "There are no garages to fill yet.";
      return;
    }
    const countRaw = simCount.value.trim();
    const count = countRaw === "" ? null : parseInt(countRaw, 10);   // null = fill all remaining
    const hours = parseFloat(simHours.value) || 2;
    simRun.disabled = true;
    try {
      const { data, error } = await CarColors.simulateFill(sb, { garageId, count, hours });
      if (error) {
        simMsg.className = "msg error";
        simMsg.textContent = error.message;
      } else {
        simMsg.className = "msg success";
        simMsg.textContent = `🧪 Simulated ${data} car(s) parking for ${hours}h.`;
        loadStats();
      }
    } finally {
      simRun.disabled = false;
    }
  });

  // --- Self-tests ---
  const selftestOut = document.getElementById("selftest-out");

  async function runSelfTest(rpc, label) {
    selftestOut.innerHTML = `<p class="muted">Running ${escapeHtml(label)}…</p>`;
    const { data, error } = await sb.rpc(rpc);
    if (error) {
      selftestOut.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
      return;
    }
    const rows = data || [];
    const passed = rows.filter((r) => r.ok).length;
    const total = rows.length;
    const allOk = total > 0 && passed === total;
    const head = `<p class="${allOk ? "ok" : "bad"}"><strong>${escapeHtml(label)}: ${passed}/${total} passed</strong></p>`;
    const fails = rows
      .filter((r) => !r.ok)
      .map((r) => `<div class="selftest-row bad">✗ ${escapeHtml(JSON.stringify(r))}</div>`)
      .join("");
    selftestOut.innerHTML = head + (allOk ? `<p class="ok">All checks passed ✅</p>` : fails);
  }

  document.getElementById("selftest-price").addEventListener("click", () => runSelfTest("price_selftest", "Pricing self-test"));
  document.getElementById("selftest-color").addEventListener("click", () => runSelfTest("color_selftest", "Colour self-test"));

  // --- Refresh buttons + initial load ---
  document.getElementById("stats-refresh").addEventListener("click", loadStats);
  document.getElementById("tickets-refresh").addEventListener("click", loadTickets);

  loadStats();
  loadTickets();
  loadGaragesForSim();
});
