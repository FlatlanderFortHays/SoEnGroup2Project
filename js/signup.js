// Shared account-creation page for all three portals. Reads ?role= from the
// URL to preselect the role (falls back to "user"); on success, logs the new
// account in (via Auth.signup — see supabaseClient.js) and sends the person
// to that portal.

(function() {
    const ROLE_PAGES = { user: "user.html", owner: "owner.html", tow: "tow.html" };

    const params    = new URLSearchParams(location.search);
    const roleEl    = document.getElementById("signup-role");
    const userEl    = document.getElementById("signup-username");
    const passEl    = document.getElementById("signup-password");
    const confirmEl = document.getElementById("signup-confirm");
    const errorEl   = document.getElementById("signup-error");
    const backLink  = document.getElementById("back-to-login");
    const form      = document.getElementById("signup-form");

    const requested = params.get("role");
    roleEl.value = ROLE_PAGES[requested] ? requested : "user";
    backLink.href = ROLE_PAGES[roleEl.value];

    roleEl.addEventListener("change", () => {
        backLink.href = ROLE_PAGES[roleEl.value];
    });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        errorEl.textContent = "";

        if (passEl.value !== confirmEl.value) {
            errorEl.textContent = "Passwords don't match.";
        return;
        }

        try {
            await Auth.signup(userEl.value, passEl.value, roleEl.value);
            location.href = ROLE_PAGES[roleEl.value];
        } catch (err) {
            errorEl.textContent = err.message || String(err);
        }
    });
})();