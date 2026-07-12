// Shared account-creation page for all three portals. Reads ?role= from the
// URL to preselect the role (falls back to "user"); on success, logs the new
// account in (via Auth.signup — see supabaseClient.js) and sends the person
// to that portal.

(function() {
    const ROLE_PAGES = { user: "user.html", owner: "owner.html", tow: "tow.html" };

    const params    = new URLSearchParams(location.search);
    const roleE1    = document.getElementById("signup-role");
    const userE1    = document.getElementById("signup-username");
    const passE1    = document.getElementById("signup-password");
    const confirmE1 = document.getElementById("signup-confirm");
    const errorE1   = document.getElementById("signup-error");
    const backLink  = document.getElementById("back-to-login");
    const form      = document.getElementById("signup-form");

    const requested = params.get("role");
    roleE1.value = ROLE_PAGES[requested] ? requested : "user";
    backLink.href = ROLE_PAGES[roleE1.value];

    roleE1.addEventListener("change", () => {
        backLink.href = ROLE_PAGES[roleE1.value];
    });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        errorE1.textContent = "";

        if (passE1.value !== confirmE1.value) {
            errorE1.textContent = "Passwords don't match.";
        return;
        }

        try {
            await Auth.signup(userE1.value, passE1.value, roleE1.value);
            location.href = ROLE_PAGES[roleE1.value];
        } catch (err) {
            errorE1.textContent = err.message || String(err);
        }
    });
})();