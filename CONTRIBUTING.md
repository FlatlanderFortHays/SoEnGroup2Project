# Contributing to Park Now

Welcome! This project is built to be **easy to add to** — no build tools, no install, just
HTML/CSS/JS talking to a Supabase database. This guide shows how the pieces fit together and walks
through adding a feature end to end.

## How the pieces connect

Every portal follows the same shape:

```
A page  (user.html / owner.html / tow.html)
   │  loads
   ▼
its script  (js/user.js / js/owner.js / js/tow.js)
   │  calls
   ▼
Supabase  ──►  PostgreSQL database
```

There are two ways the JavaScript talks to the database:

| You want to… | Use | Example |
| --- | --- | --- |
| Read or write a table directly | `sb.from('table')…` | `sb.from('cars').insert({ … })` |
| Run "smart" logic in the database | `sb.rpc('function', { … })` | `sb.rpc('park_car', { p_garage_id, p_car_id, p_hours })` |

Shared helpers live in `js/supabaseClient.js`: **`sb`** (the client), **`Auth`** (username login),
**`escapeHtml`**, and **`initPortal`** (wires up the login box each page shares).

## The data flow of a single click

```
You click a button in the page
        ↓
an event listener in js/<page>.js runs
        ↓
it calls Supabase:  sb.from(...).insert/select   OR   sb.rpc(...)
        ↓
Supabase runs it on PostgreSQL and returns { data, error }
        ↓
your JS checks `error`, then updates the page (re-renders a list)
```

## Anatomy of a feature: add a phone number to cars

Goal: save a phone number with each car. This touches all three layers — a perfect first feature.

**1. Add the input — `user.html`**
Find the car form (`<form id="car-form">`) and add an input alongside the others:
```html
<input id="car-phone" placeholder="Phone number" autocomplete="off" />
```

**2. Send it to the database — `js/user.js`**
In the `car-form` submit handler the code builds a `car` object. Add the phone field:
```js
const car = {
  user_id: session.id,
  make:  document.getElementById("car-make").value.trim(),
  model: document.getElementById("car-model").value.trim(),
  color: document.getElementById("car-color").value.trim(),
  license_plate: document.getElementById("car-plate").value.trim(),
  phone: document.getElementById("car-phone").value.trim(), // ← new
};
```

**3. Add the column to the database — Supabase SQL Editor**
> ⚠️ **Important:** re-running `schema.sql` will **not** add the column — `create table if not exists`
> leaves an existing table untouched. To add a column to a table that already exists, run this once in
> the **SQL Editor**:
```sql
alter table cars add column if not exists phone text;
```
Also add `phone text` to the `cars` table in `supabase/schema.sql` so a fresh setup includes it.

**4. Test it**
Open the User portal (Live Server), add a car with a phone number, then check the **cars** table in the
Supabase **Table Editor** — your value should be there.

**5. Commit it** (see the Git workflow below).

> Want the **Tow Company** to *see* a new field? That list comes from the `currently_parked` **view**.
> Views use `create or replace`, so editing the view in `schema.sql` and re-running it **does** update it —
> then add the column to the table in `tow.html` and the row template in `js/tow.js`.

## Running it locally

- **Easiest:** open `index.html` in your browser.
- **Better:** in VS Code install **Live Server** → right-click `index.html` → *Open with Live Server*
  (auto-reloads when you save).
- Keep the **browser console open** (**F12** → Console) — it shows errors and anything you `console.log(...)`.
- Use the **Supabase Table Editor** to inspect the real data.

## The Git workflow

1. Make a branch: `git checkout -b my-feature`
2. Make your change and test it locally.
3. Commit: `git commit -am "Short description of what you did"`
4. Push: `git push -u origin my-feature`
5. Open a **Pull Request** on GitHub, let a teammate review, then merge to `main`.
6. **Cloudflare auto-deploys `main`** — your change is live within a minute.

(For tiny edits you can also change a file directly on GitHub.com.)

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Buttons do nothing | Open with **Live Server**, not a `file://` double-click. Check the **F12 console** for errors. |
| "I added a DB column but the app errors" | Run `alter table … add column …` in the SQL Editor — re-running `schema.sql` won't add columns to an existing table. |
| Data won't load | F12 console → read the error. Usually a table/column name in the JS doesn't match the database. |
| I see old data or old code | Hard-refresh: **Ctrl+F5** (Windows) / **Cmd+Shift+R** (Mac). |
| Tow portal is empty | Park at least one car first — it only lists cars whose time hasn't expired. |

Questions? See **[FEATURE_IDEAS.md](FEATURE_IDEAS.md)** for good first tasks, or ask the team.
