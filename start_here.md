# 🟢 Start Here — New Teammate Setup

Welcome to **Park Now**! This guide gets you from zero to "I can edit the site and test my
own changes safely" in three parts:

1. [Get the project into VS Code on your own branch](#1-get-the-project-on-your-own-branch)
2. [Set up your own Supabase database for testing](#2-set-up-your-own-database-for-testing)
3. [View the website locally](#3-view-the-website-locally)

Take it slow — you only do this setup once. When you're done, you're ready to start building — check
with the team on what to work on.

---

## Before you start (install these once)

- **[VS Code](https://code.visualstudio.com/)** — our code editor.
- **[Git](https://git-scm.com/downloads)** — how we share code. (After installing, restart VS Code.)
- A **[GitHub](https://github.com/)** account — and ask the team lead to **add you as a collaborator**
  on the repo (otherwise you can't push your branch).

> The project is at **https://github.com/FlatlanderFortHays/SoEnGroup2Project**

---

## 1. Get the project on your own branch

We never edit `main` directly. Everyone works on their **own branch** — a personal copy of the code —
then opens a Pull Request to merge it in. Here's the whole thing inside VS Code.

### 1a. Download the project (clone it)
1. Open **VS Code**.
2. Press **Ctrl+Shift+P** → type **"Git: Clone"** → Enter.
3. Paste the repo URL: `https://github.com/FlatlanderFortHays/SoEnGroup2Project.git` → Enter.
4. Pick a folder to save it in (e.g. your Desktop). When it asks, click **"Open"** to open the project.
5. If VS Code asks you to sign in to GitHub, do it — this lets you push later.

You now have the whole project on your computer.

### 1b. Create your branch
1. Look at the **bottom-left corner** of VS Code — it shows the current branch (it'll say **`main`**).
2. **Click it.** A menu opens at the top → choose **"Create new branch..."**.
3. Name it something clear, like `feature/yourname-phone-field` → press Enter.
4. The bottom-left now shows your new branch name. You're working on your own copy. ✅

### 1c. Put your branch on GitHub
1. Open the **Source Control** panel (the branching icon on the left sidebar, or **Ctrl+Shift+G**).
2. Click **"Publish Branch"** (or "..." menu → Push). This uploads your branch to GitHub so the team
   can see it and you don't lose your work.

> 💾 **Saving your work as you go:** in the Source Control panel, type a short message describing your
> change, click **✓ Commit**, then **Sync/Push**. When the feature is done, open a **Pull Request** on
> GitHub (it'll prompt you to **"Compare & pull request"**), get a quick review, and merge to `main`.

---

## 2. Set up your own database for testing

The app shares **one** team database. If your feature changes the database (adds a column, etc.), you
should test against **your own** copy first so you can't break the shared one. Supabase is free and you
can have your own project. **You will not edit any shared file to do this** — it's a per-browser switch.

### 2a. Create your free Supabase project
1. Go to **[supabase.com](https://supabase.com/)** → sign in → **New project**.
2. Name it `parknow-dev-yourname`, choose a region near you, and set a database password
   (save it somewhere). Click **Create** and wait ~2 minutes for it to finish setting up.

### 2b. Build the database (run the schema)
1. In your new project, open **SQL Editor** (left sidebar) → **New query**.
2. In VS Code, open **[supabase/schema.sql](supabase/schema.sql)**, select all (**Ctrl+A**), copy.
3. Paste it into the Supabase SQL Editor → click **Run**.
4. You should see "Success." Open the **Table Editor** — you now have the same tables as the real app.

### 2c. Get your project's keys
In Supabase: **Project Settings → API**, and copy two things:
- **Project URL** (looks like `https://abcd1234.supabase.co`)
- the **anon / public** key (a long string starting with `sb_publishable_…`)

### 2d. Tell your browser to use YOUR database
This is the safe switch — it only affects **your browser**, and touches **no files**.

1. Open the site locally first (do [Part 3](#3-view-the-website-locally) below), then open one of the
   portal pages (e.g. the User portal).
2. Press **F12** to open Developer Tools → click the **Console** tab.
3. Paste this (with **your** values from step 2c) and press Enter:
   ```js
   localStorage.setItem("PARKNOW_DEV_URL", "https://YOUR-dev-ref.supabase.co");
   localStorage.setItem("PARKNOW_DEV_KEY", "sb_publishable_YOUR_dev_key");
   location.reload();
   ```
4. After it reloads, the console shows **"⚠️ Park Now is using YOUR personal dev database"** — that means
   it worked. Everything you do now (add cars, garages, park) goes into *your* database, not the team's.

**To switch back to the shared team database** (paste in the console):
```js
localStorage.removeItem("PARKNOW_DEV_URL");
localStorage.removeItem("PARKNOW_DEV_KEY");
location.reload();
```

> 📌 When your feature needs a database change, make it in **your** dev project **and** add the same change
> to `supabase/schema.sql` in your branch — that way it travels with your Pull Request, and the team lead
> applies it to the shared database when your work is merged.

---

## 3. View the website locally

You don't need to push anything to see your changes — run the site right on your computer.

### Option A — Live Server (recommended; auto-reloads when you save)
1. In VS Code, open the **Extensions** panel (**Ctrl+Shift+X**).
2. Search **"Live Server"** (by Ritwick Dey) → **Install**.
3. Right-click **`index.html`** in the file list → **"Open with Live Server"**.
4. Your browser opens at something like `http://127.0.0.1:5500/`. Edit a file, hit **Save**, and the page
   refreshes automatically. 🎉

### Option B — just open the file
Double-click `index.html` (or drag it into your browser). It works and talks to the database fine — you
just won't get auto-reload, so you'll refresh manually after each change.

> 🔎 **Tip:** keep the browser **Console (F12)** open while you work — it shows errors and is where you
> set your dev database (Part 2d).

---

## ✅ You're set up!

- Project on your own branch in VS Code ✔
- Your own database for safe testing ✔
- The site running locally ✔

**Next:** ask the team what to build, and start coding. Welcome aboard! 🚗
