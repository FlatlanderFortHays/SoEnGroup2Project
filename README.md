# 🅿️ Park Now

A simple parking-garage web app with three portals:

| Portal | What it does |
| --- | --- |
| 🚗 **User** | Register your car, browse garages, and reserve a spot for X hours. |
| 🏢 **Owner** | Add a garage (name + floors × rows × slots-per-row), watch occupancy, and view a live map of any garage. |
| 🚛 **Tow Company** | See every car currently *legally* parked in a garage. |
| 🗺️ **Garage Simulation** | A public, login-free live map of a garage's spots (filled vs open), with a "Simulate fill" button. |

**Stack:** plain HTML/CSS/JS (no build step) + [Supabase](https://supabase.com) (hosted PostgreSQL) + Cloudflare Pages (auto-deploys from GitHub). **There is no backend server to run** — the site talks to the database through the Supabase client.

---

## How it works (the 30-second version)

```
Your browser  ──supabase-js──►  Supabase (PostgreSQL + auto API)
   (the site)                      (shared cloud database)
```

- "Login" is just a **username** (no passwords) — stored per role in your browser.
- A garage's open spots are computed live: a reservation counts while `parked_until` is in the future, then the spot frees itself automatically.
- The tricky bits — assigning the lowest free spot, and the **Simulate** button — run as PostgreSQL functions (`park_car`, `simulate_fill`) so they're correct and race-free.

---

## 🧑‍💻 Working on it (everyone)

> 🧑‍🎓 **Brand-new teammate?** Read **[start_here.md](start_here.md)** first — it walks you through getting the project into VS Code on your own branch, setting up your own test database, and running the site locally.

You **do not need Node, npm, or a database installed.** To run it locally:

- **Easiest:** just open `index.html` in your browser. (It talks to the shared cloud database.)
- **Nicer:** in VS Code, install the **Live Server** extension, right-click `index.html` → *Open with Live Server* (auto-reloads on save).

### Team workflow (like a real app company)
1. Create a **branch** for your change (`git checkout -b my-feature`).
2. Edit the HTML/CSS/JS — or even edit a file directly on **GitHub.com**.
3. Open a **Pull Request**, get a quick review, and merge to `main`.
4. **Cloudflare auto-deploys** the live site on merge.

### Inspecting the database
- Use the **Supabase dashboard** (Table Editor / SQL Editor) to view or tweak data.
- Or connect from VS Code with the **PostgreSQL** extension (`ms-ossdata.vscode-pgsql`):
  *Add Connection* → paste Host / Port `5432` / Database / User / Password from
  Supabase (**Project Settings → Database**) → set **SSL = require** → Connect.

---

## 📁 Project structure

```
index.html              Landing page (pick a portal)
user.html  / js/user.js   User portal:  cars, park-now, "Simulate full lot"
owner.html / js/owner.js  Owner portal: add garages, see occupancy
tow.html   / js/tow.js    Tow portal:   currently-parked list
simulation.html / js/simulation.js  Garage Simulation: live spot map (no login)
css/styles.css            Shared styles
js/config.js              Supabase URL + anon key (PUBLIC, already set — don't change)
js/supabaseClient.js      Shared client + username login helper
supabase/schema.sql       The database (run once in Supabase SQL Editor)
start_here.md             New-teammate setup — read this first
```