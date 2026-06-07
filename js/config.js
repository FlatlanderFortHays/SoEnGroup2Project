// ---------------------------------------------------------------------
//  Supabase credentials  (PUBLIC by design — safe to commit).
//
//  The two values below are the SHARED team (production) database. They are
//  public on purpose for a static site; access is controlled by the database's
//  Row Level Security, not by hiding these.
//
//  ⚠️  TEAMMATES: do NOT edit the two PROD_ lines below. This is the shared
//      database — changing them repoints the live site at a different (empty)
//      database and breaks the app for everyone.
//
//  ✅  Working on a feature that changes the database? Test against your OWN
//      free Supabase project instead — WITHOUT touching this file. In your
//      browser console (press F12 → Console) run this once:
//        localStorage.setItem("PARKNOW_DEV_URL", "https://YOUR-dev-ref.supabase.co")
//        localStorage.setItem("PARKNOW_DEV_KEY", "sb_publishable_YOUR_dev_key")
//        location.reload()
//      To switch back to the shared database:
//        localStorage.removeItem("PARKNOW_DEV_URL"); localStorage.removeItem("PARKNOW_DEV_KEY"); location.reload()
//      Full walkthrough: see start_here.md.
// ---------------------------------------------------------------------

(function () {
  // Shared (production) database — do not edit these two lines.
  const PROD_URL = "https://ymxokfqiuncxlubwdabb.supabase.co";
  const PROD_KEY = "sb_publishable_Qg593P_4xXgWClUwwLnceg_T74KIu_Y";

  // Optional personal dev-database override (per browser, never committed).
  const devUrl = localStorage.getItem("PARKNOW_DEV_URL");
  const devKey = localStorage.getItem("PARKNOW_DEV_KEY");

  window.SUPABASE_URL = devUrl || PROD_URL;
  window.SUPABASE_ANON_KEY = devKey || PROD_KEY;

  if (devUrl) {
    console.warn("⚠️ Park Now is using YOUR personal dev database, not the shared team one.");
  }
})();
