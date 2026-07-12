# 🗺️ Garage Simulation — How It Works

The **Garage Simulation** is a public, login-free page that draws a **live map** of one
garage's parking spots — yellow stalls are open, a coloured car means the spot is taken —
and lets anyone click **Simulate fill** to instantly park fake cars in every open spot for a
demo. It shares its map renderer with the Owner portal's "View map" panel, so both look
identical.

> New to the project overall? Read **[README.md](README.md)** and **[start_here.md](start_here.md)**
> first — this doc zooms in on just the simulation.

---

## 🧰 What it's built with

| Layer | Technology | Notes |
| --- | --- | --- |
| Page & layout | **HTML5** | [simulation.html](simulation.html) |
| Styling | **CSS3** | shared [css/styles.css](css/styles.css) — no framework |
| Logic | **Vanilla JavaScript** (ES6) | no React/Vue, **no build step** — the browser runs the files as-is |
| The map drawing | **HTML5 Canvas 2D API** | the lot is *drawn*, pixel by pixel, not built from HTML elements |
| Database + API | **Supabase** (hosted **PostgreSQL**) | reached from the browser via the Supabase JS client |
| Server-side logic | **SQL / PL/pgSQL** | the `simulate_fill` function + views live in the database |

**The only third-party library** is the official **Supabase JS client**, loaded straight
from a CDN — no `npm install`, no bundler, nothing to compile:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

Everything else (the map engine, pan/zoom, tooltips, floor rail) is hand-written plain
JavaScript.

---

## 📁 The files involved

The page pulls in five scripts, **in this order** (see the bottom of
[simulation.html](simulation.html)):

```
1. supabase-js (CDN)        → provides the global `supabase` (the client library)
2. js/config.js             → the Supabase URL + public key (which database to talk to)
3. js/supabaseClient.js     → creates the shared client `sb` + the escapeHtml() helper
4. js/garageMap.js          → the reusable Canvas map engine (GarageMap)
5. js/simulation.js         → the page's own logic (buttons, dropdown, auto-refresh)
```

| File | Role |
| --- | --- |
| [simulation.html](simulation.html) | The page: garage dropdown, Simulate/Clear buttons, zoom slider, and an empty `#sim-viewport` the map draws itself into. No login UI — unlike the other portals it doesn't use `initPortal`. |
| [js/simulation.js](js/simulation.js) | Loads the garage list, calls the map engine, and wires up the buttons (Simulate fill, Clear simulated, Refresh, Auto-refresh, Zoom). |
| [js/garageMap.js](js/garageMap.js) | The **shared Canvas renderer** (`GarageMap`). Loads a garage's data and paints the lot. Also used by [js/owner.js](js/owner.js). |
| [js/config.js](js/config.js) | The public Supabase URL + anon key (safe to commit; access is controlled by the database, not by hiding these). |
| [js/supabaseClient.js](js/supabaseClient.js) | Creates the one shared `sb` client and small helpers. |
| [css/styles.css](css/styles.css) | Shared look (the dark map viewport, floor rail, tooltip, buttons). |
| [supabase/schema.sql](supabase/schema.sql) | The database side — the tables, the two views, and the `simulate_fill` function the page calls. |

---

## 🔄 How a request flows

```
       pick a garage / click a button
                  │
   js/simulation.js ──► GarageMap.load(id) ──► Supabase (PostgreSQL)
                  │            reads two VIEWS:
                  │              • garage_availability  (name, total, occupied)
                  │              • currently_parked     (one row per parked car)
                  ▼
   GarageMap paints the lot onto an HTML5 <canvas>
```

- **Reading the map:** `GarageMap.load(garageId)` fetches the garage row from the
  `garage_availability` view and every active car from the `currently_parked` view, then
  hands both to the renderer. A spot counts as *occupied* exactly while its reservation's
  `parked_until` is still in the future — expired ones free themselves, no cleanup job.
- **Simulate fill:** the button calls the PostgreSQL function `simulate_fill` (via
  `sb.rpc(...)`), which creates random fake cars (owned by a built-in `simulator` account)
  in every open spot. Doing the fill *inside the database* keeps it fast and race-free.
- **Clear simulated:** deletes only the reservations flagged `is_simulated = true`, so real
  reservations are left untouched.
- **Auto-refresh:** an optional 5-second `setInterval` re-runs the fetch so the map stays
  live. A small "generation" counter (`gen`) throws away a slow response if a newer one has
  already started — so stale data never paints over fresh data.

---

## 🎨 The map engine ([js/garageMap.js](js/garageMap.js))

The map is a single HTML5 `<canvas>` the code draws onto — not a grid of `<div>`s. That
keeps it smooth even with hundreds of spots.

**What it does:**
- **Derives the layout from the garage's dimensions.** A garage stores `floors`, `rows`,
  and `slots_per_row`; `buildGeometry()` turns those into stall rectangles (two rows of
  stalls facing a shared aisle, lettered A, B, C… with codes like `A203` = row A, floor 2,
  spot 03). Older garages with no dimensions fall back to a simple flat grid.
- **One floor at a time**, with the other floors shown as clickable thumbnails in the left
  **floor rail**.
- **Pan & zoom** — drag to pan, mouse-wheel or the slider to zoom, two-finger pinch on
  touch. Off-screen stalls are skipped while drawing (culling) for speed.
- **Hover tooltip** showing the car's colour/make/model, plate, size, EV flag, and expiry.
- **Little status marks:** a green ⚡ badge on EV cars and a violet tag on simulated ones.
- **Accessibility:** it also writes a hidden text list of parked cars and an `aria-label`
  summary, so screen readers aren't left out by the canvas.
- **Performance cap:** lots over `MAX_SPOTS` (2500) show a notice instead of drawing, so a
  giant garage can't freeze the tab.
- **Sprite-ready:** cars currently render as tidy coloured blocks. There's a finished image
  loader behind a `SPRITES_ENABLED` flag — drop pixel-art PNGs into `assets/cars/` and flip
  it to `true` and the blocks become sprites, no other changes needed.

---

## 🗄️ The database side ([supabase/schema.sql](supabase/schema.sql))

The simulation reads/writes three database objects:

- **`garage_availability`** (view) — per-garage `total_spots`, live `occupied`, and
  `open_spots`. Powers both the dropdown and the "X / Y occupied" summary.
- **`currently_parked`** (view) — one row per car that's *currently* legally parked
  (its `parked_until` is in the future), joined to the car's make/model/colour/plate.
- **`simulate_fill(garage_id, count, hours)`** (function) — parks random fake cars in the
  open spots. Called with `count = null` to fill the whole lot.

**One important invariant:** a garage's `total_spots` must equal
`floors × rows × slots_per_row`, because the counts/`simulate_fill` trust `total_spots`
while the *map* derives its geometry from the three dimensions. If they ever disagree, the
simulator fills fewer spots than the map draws. A database **trigger**
(`garages_sync_total_spots`) keeps the two in lock-step automatically, so they can't drift
apart — no matter whether a garage is created by the app or hand-edited in the Supabase
table editor.

---

## ▶️ Running / testing it

No build, no server — same as the rest of the site:

- **Easiest:** open [simulation.html](simulation.html) in a browser (it talks to the shared
  cloud database).
- **Nicer:** in VS Code use the **Live Server** extension → right-click
  [simulation.html](simulation.html) → *Open with Live Server* (auto-reloads on save).

**Try it:** pick a garage → **Simulate fill** → every open spot fills with a car and the
summary updates → drag/scroll to explore, use the floor rail to switch levels →
**Clear simulated** to reset. To test database changes safely, point your browser at your
own Supabase project first (see [start_here.md](start_here.md) → *Set up your own database*).
