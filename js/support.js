// Contact Support page. Reuses the shared initSupportForm() from js/supabaseClient.js
// (which both files a ticket AND renders this account's own tickets), resolving the
// existing per-role session passed in via ?role=user|owner|tow. Login-gated: you reach
// it from a portal's topbar link, so if there's no matching session we bounce back.
(function () {
  const role = new URLSearchParams(location.search).get("role") || "user";
  const portal = role + ".html";
  const session = Auth.get(role);

  if (!session || session.role !== role) {
    location.href = portal;   // not logged in to this portal — send them to log in
    return;
  }

  const nameEl = document.getElementById("whoami-name");
  if (nameEl) nameEl.textContent = `${session.username} (${session.role})`;
  const back = document.getElementById("back-link");
  if (back) back.href = portal;
  const logout = document.getElementById("logout");
  if (logout) logout.addEventListener("click", () => { Auth.clear(role); location.href = portal; });

  initSupportForm(session);   // wires the form AND renders this account's ticket list
})();
