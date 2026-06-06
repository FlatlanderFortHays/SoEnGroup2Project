# 🅿️ Park Now

A simple parking-garage web app with three portals:

| Portal | What it does |
| --- | --- |
| 🚗 **User** | Register your car, browse garages, and reserve a spot for X hours. |
| 🏢 **Owner** | Add a garage (name + number of spots) and watch occupancy. |
| 🚛 **Tow Company** | See every car currently *legally* parked in a garage. |

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

## ⚙️ One-time setup (one person does this)

> ✅ **Already set up?** If `js/config.js` already has a real `SUPABASE_URL` and
> `SUPABASE_ANON_KEY` filled in, the database is ready — **skip to "Working on it"** below.

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (free).
2. In the dashboard, open **SQL Editor → New query**, paste the contents of
   [supabase/schema.sql](supabase/schema.sql), and click **Run**.
   You should now see 4 tables, 2 views, and 2 functions in the **Table Editor**.
3. Open **Project Settings → API** and copy:
   - **Project URL**
   - **anon / public** key
4. Paste both into [js/config.js](js/config.js), then commit & push.
   Cloudflare redeploys automatically and the whole team shares one database.

> 🔓 **Security note:** the anon key is *meant* to be public for a static site, so committing it is fine. But the database currently uses **permissive** rules: **anyone who opens the site can read, modify, or DELETE any** garage, car, or reservation. That's fine for a class demo — but locking this down with real Row Level Security is the required step before any public launch.

---

## 🧑‍💻 Working on it (everyone)

> 🧑‍🎓 **New contributor?** Start with **[CONTRIBUTING.md](CONTRIBUTING.md)** (how to add a feature, step by step) and **[FEATURE_IDEAS.md](FEATURE_IDEAS.md)** (good first tasks + what *not* to touch).

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
css/styles.css            Shared styles
js/config.js              Supabase URL + anon key (PUBLIC, already set — don't change)
js/supabaseClient.js      Shared client + username login helper
supabase/schema.sql       The database (run once in Supabase SQL Editor)
CONTRIBUTING.md           How to add a feature (start here)
FEATURE_IDEAS.md          Good first tasks + "don't touch" list
```

---

## ✅ Demo script (try it end-to-end)

1. **Owner** portal → log in → add **"Garage A"** with **5** spots.
2. **User** portal → log in → add a car → see Garage A shows **5/5 open** →
   **Park now** for 2h → you're given **spot #1** (now **4/5 open**).
3. Click **Simulate full lot** on Garage A → it fills the rest →
   a fresh **Park now** shows **🚫 No spots available**.
4. **Tow** portal → pick Garage A → see the full list of parked cars
   (your real one + the simulated ones) with plate, vehicle, and "parked until".
5. To watch a spot free itself, simulate with a tiny duration (e.g. `0.1` hours ≈ 6 min);
   after it passes, the garage shows open again and the car drops off the tow list.
