// ---------------------------------------------------------------------
//  Shared front-end helpers used by every portal page.
//  Load order (see each .html):
//     1. supabase-js (CDN)   -> provides window.supabase
//     2. config.js           -> provides window.SUPABASE_URL / _ANON_KEY
//     3. this file           -> provides `sb`, `Auth`, `initPortal`, `escapeHtml`
//     4. the page script     -> owner.js / user.js / tow.js
// ---------------------------------------------------------------------

// The one Supabase client the whole page shares. (Named `sb` so it doesn't
// clash with the CDN's global `supabase`.)
const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

// Escape user-supplied text before putting it in innerHTML.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// ---- Username-only "login", remembered per role in localStorage ----
// (Per-role keys mean one person can be logged into all three portals in the
//  same browser — handy for demos.)
const Auth = {
  keyFor(role) { return `parknow_session_${role}`; },

  get(role) {
    try { return JSON.parse(localStorage.getItem(this.keyFor(role))); }
    catch { return null; }
  },

  set(role, session) {
    localStorage.setItem(this.keyFor(role), JSON.stringify(session));
  },

  clear(role) { localStorage.removeItem(this.keyFor(role)); },

  // Find-or-create the account for {username, role}; remember it; return it.
  async login(username, role) {
    username = (username || "").trim();
    if (!username) throw new Error("Please enter a username.");

    const { data, error } = await sb
      .from("accounts")
      .upsert({ username, role }, { onConflict: "username,role" })
      .select()
      .single();
    if (error) throw error;

    const session = { id: data.id, username: data.username, role: data.role };
    this.set(role, session);
    return session;
  },
};

// Wire up the login form / logout / who-am-i bar that every portal shares,
// then hand control to the page via onReady(session).
//
// The page's HTML must contain elements with these ids:
//   #login, #app, #whoami, #whoami-name, #logout,
//   #login-form, #login-username, #login-error
function initPortal(role, onReady) {
  const loginSection = document.getElementById("login");
  const appSection   = document.getElementById("app");
  const whoami       = document.getElementById("whoami");
  const whoamiName   = document.getElementById("whoami-name");
  const form         = document.getElementById("login-form");
  const input        = document.getElementById("login-username");
  const errorEl      = document.getElementById("login-error");

  function showApp(session) {
    loginSection.classList.add("hidden");
    appSection.classList.remove("hidden");
    whoami.classList.remove("hidden");
    whoamiName.textContent = `${session.username} (${session.role})`;
    onReady(session);
  }

  document.getElementById("logout").addEventListener("click", () => {
    Auth.clear(role);
    location.reload();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.textContent = "";
    try {
      showApp(await Auth.login(input.value, role));
    } catch (err) {
      errorEl.textContent = err.message || String(err);
    }
  });

  // Resume an existing session for this role, if any.
  const existing = Auth.get(role);
  if (existing && existing.role === role) showApp(existing);
}
