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

// ---- Username + password login, remembered per role in localStorage ----
// The password is bcrypt-hashed in Postgres by the signup()/login() functions
// in supabase/schema.sql; the browser only ever sends the plaintext over HTTPS
// and stores the returned {id, username, role} — never a hash.
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


  // Create a new account. Hashing happens in Postgres
  // plaintext password sent over HTTPS
  async signup(username, password, role) {
    username = (username || "").trim();
    if (!username) throw new Error("Please enter a username.");
    if (!password || password.length < 4) throw new Error("Password must be at least 4 characters.");

    const { data, error } = await sb.rpc("signup", {
      p_username: username,
      p_password: password,
      p_role: role,
    });
    if (error) throw new Error(error.message);

    // signup() is `returns table (...)`, i.e. a SET — so supabase-js hands back
    // an ARRAY, and a bare `data.id` would be undefined. (Same idiom as
    // js/user.js where park_car's result is unwrapped.)
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("Sign-up failed. Please try again.");

    const session = { id: row.id, username: row.username, role: row.role };
    this.set(role, session);
    return session;
  },

  // Verify {username, password } against stored hash
  async login(username, password, role) {
    username = (username || "").trim();
    if (!username) throw new Error("Please enter a username.");
    if (!password) throw new Error("Please enter your password.");

    const { data, error } = await sb.rpc("login", {
      p_username: username,
      p_password: password,
      p_role: role,
    });
    if (error) throw new Error(error.message);

    // login() is `returns table (...)` too — unwrap the array (see signup above).
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("Invalid username or password.");
    // initPortal only resumes a session when session.role === the portal's role,
    // so guard the invariant here rather than silently landing on a login screen.
    if (row.role !== role) throw new Error(`That account is not a ${role} account.`);

    const session = { id: row.id, username: row.username, role: row.role };
    this.set(role, session);
    return session;
  },
};

// Contact Support form shared by every portal. A page opts in simply by including the
// #support-* markup inside its logged-in view; initPortal calls this after onReady, so
// there is no per-portal JS. The ticket is filed FROM the signed-in account, with the
// sender's role + username denormalized onto the row so the dev console (dev.html) can
// show who filed it without reading the locked-down accounts table.
function initSupportForm(session) {
  const submit = document.getElementById("support-submit");
  if (!submit) return;                       // page has no support form — nothing to wire
  const subject = document.getElementById("support-subject");
  const message = document.getElementById("support-message");
  const msg     = document.getElementById("support-msg");
  const list    = document.getElementById("support-list");   // optional "your tickets" list

  // Render this account's own tickets (with live status) when the page includes the
  // list. RLS is permissive, so filter to this account on the client — same pattern as
  // the reservations list in js/user.js. The dev console (dev.html) is where status is set.
  async function loadMyTickets() {
    if (!list) return;
    const { data, error } = await sb
      .from("support_tickets")
      .select("id, subject, status, created_at")
      .eq("user_id", session.id)
      .order("created_at", { ascending: false });
    if (error) {
      list.innerHTML = `<li class="error">${escapeHtml(error.message)}</li>`;
      return;
    }
    if (!data.length) {
      list.innerHTML = `<li class="muted">You haven't filed any tickets yet.</li>`;
      return;
    }
    list.innerHTML = data.map((t) => {
      const when = t.created_at ? new Date(t.created_at).toLocaleString() : "";
      return `
        <li class="list-row">
          <span class="grow">
            <strong>${escapeHtml(t.subject)}</strong>
            <br /><span class="muted">${escapeHtml(when)}</span>
          </span>
          <span class="badge">${escapeHtml(t.status || "Open")}</span>
        </li>`;
    }).join("");
  }

  submit.addEventListener("click", async () => {
    msg.className = "msg";
    msg.textContent = "";
    const subjectVal = (subject.value || "").trim();
    const messageVal = (message.value || "").trim();
    if (!subjectVal || !messageVal) {
      msg.className = "msg error";
      msg.textContent = "Please fill in both a subject and a message.";
      return;
    }

    submit.disabled = true;
    try {
      const { error } = await sb.from("support_tickets").insert({
        user_id:  session.id,
        role:     session.role,       // which portal filed it (denormalized for the dev view)
        username: session.username,
        subject:  subjectVal,
        message:  messageVal,
      });
      if (error) {
        msg.className = "msg error";
        msg.textContent = error.message;
        return;
      }
      subject.value = "";
      message.value = "";
      msg.className = "msg success";
      msg.textContent = "✅ Support request submitted — our team will follow up.";
      loadMyTickets();   // show the ticket that was just filed
    } finally {
      submit.disabled = false;
    }
  });

  loadMyTickets();   // initial render
}

// Wire up the login form / logout / who-am-i bar that every portal shares,
// then hand control to the page via onReady(session).
//
// The page's HTML must contain elements with these ids:
//   #login, #app, #whoami, #whoami-name, #logout,
//   #login-form, #login-username, #login-error
function initPortal(role, onReady) {
  const loginSection  = document.getElementById("login");
  const appSection    = document.getElementById("app");
  const whoami        = document.getElementById("whoami");
  const whoamiName    = document.getElementById("whoami-name");
  const form          = document.getElementById("login-form");
  const input         = document.getElementById("login-username");
  const passwordInput = document.getElementById("login-password");
  const errorEl       = document.getElementById("login-error");
  const createBtn     = document.getElementById("create-account");

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
      const password = passwordInput ? passwordInput.value : "";
      showApp(await Auth.login(input.value, password, role));
    } catch (err) {
      errorEl.textContent = err.message || String(err);
    }
  });

  if (createBtn) {
    createBtn.addEventListener("click", () => {
      location.href = `signup.html?role=${role}`;
    });
  }

  // Resume an existing session for this role, if any.
  const existing = Auth.get(role);
  if (existing && existing.role === role) showApp(existing);
}
