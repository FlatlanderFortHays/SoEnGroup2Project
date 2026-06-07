# Park Now — Feature Ideas

Pick something here for your next contribution. If you start one, **open a GitHub issue** saying
"I'm taking X" so two people don't build the same thing. New here? See **[start_here.md](start_here.md)**
to get set up.

## 🟢 Good first features (small, self-contained)

- Add a **phone number** or **email** field to a user's cars.
- Add a **vehicle type** dropdown (Sedan / SUV / Truck / Motorcycle) to cars.
- Show the **owner's name** next to each garage in the User and Tow portals.
- Add an **address / location** text field to garages.
- **Sort** the garage list by most open spots.
- Give the user a "**My current parking**" panel (which garage + spot + time left).
- Polish the empty states and loading messages.

## 🟡 Medium features (touch a few files / add an RPC)

- **Price per hour** on garages: the owner sets it, the user sees it, show an estimated cost when parking.
- **Extend a reservation** ("park 1 more hour") — a new RPC function plus a button.
- A "**Leave / unpark**" button that ends a reservation early.
- A simple **revenue or occupancy report** for owners.
- **Search / filter** garages by name.

## 🔴 Don't change without asking the team

These are load-bearing — changing them can break everyone's work or the live site:

- **Row Level Security (RLS) policies** in `supabase/schema.sql` — they control who can read/write.
  *(Tightening them is a planned task, but coordinate it — don't do it casually.)*
- **RPC function signatures** — the names and parameters of `park_car` and `simulate_fill`. Other code
  depends on them; add a **new** function instead of changing these.
- **The login model** — intentionally username-only (no passwords) for the demo.
- **`js/config.js` keys** — that's the **shared team database**; changing them breaks the app for everyone.
- **Cloudflare / deploy settings.**
- **Renaming existing tables or columns** — add new ones instead; renames break running code.

## Proposing something new

Open a GitHub issue describing the idea and why it's useful. Keep it small enough to finish in one PR.
