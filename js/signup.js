// ---------------------------------------------------------------------
//  Create-account page (signup.html).
//
//  Pick a role, choose a username + password, and we sign you straight in to
//  that role's portal. The "Create account" button in each portal's login box
//  (see initPortal in supabaseClient.js) sends you here as signup.html?role=…
//
//  The password is hashed in Postgres — see signup() in supabase/schema.sql.
// ---------------------------------------------------------------------

// Wrapped in an IIFE on purpose: validation.js is a classic (non-module) script
// that declares `const form` at the TOP level, so a bare `const form` here would
// collide with it — "Identifier 'form' has already been declared".
(function () {
  const form      = document.getElementById("signup-form");
  const roleEl    = document.getElementById("signup-role");
  const userEl    = document.getElementById("signup-username");
  const passEl    = document.getElementById("signup-password");
  const confirmEl = document.getElementById("signup-confirm");
  const errorEl   = document.getElementById("signup-error");
  const backLink  = document.getElementById("back-to-login");
  const submitBtn = form.querySelector('button[type="submit"]');

  // The only roles that exist, and the portal each one lives in.
  const PORTALS = { user: "user.html", owner: "owner.html", tow: "tow.html" };

  const portalFor = (role) => PORTALS[role] || PORTALS.user;

  // Keep "Already have an account? Log in" pointing at the role being created.
  function syncBackLink() {
    backLink.href = portalFor(roleEl.value);
  }

  // Preselect the role initPortal sent us. The query string is user-editable,
  // so ignore anything that isn't a real role — the <select> stays the source
  // of truth.
  const wanted = new URLSearchParams(location.search).get("role");
  if (wanted && PORTALS[wanted]) roleEl.value = wanted;
  syncBackLink();
  roleEl.addEventListener("change", syncBackLink);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.textContent = "";

    const role = roleEl.value;

    // Auth.signup (and signup() in SQL) enforce the username/length rules. The
    // one thing neither can see is whether the two password boxes agree.
    if (passEl.value !== confirmEl.value) {
      errorEl.textContent = "Passwords do not match.";
      confirmEl.focus();
      return;
    }

    submitBtn.disabled = true;   // don't fire a second signup while one's in flight
    try {
      await Auth.signup(userEl.value, passEl.value, role);
      // Auth.signup already stored the session under parknow_session_<role>, so
      // initPortal on the portal page resumes it and skips the login form.
      location.href = portalFor(role);
    } catch (err) {
      errorEl.textContent = err.message || String(err);
      submitBtn.disabled = false;
    }
  });
})();
