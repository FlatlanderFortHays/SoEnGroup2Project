// ---------------------------------------------------------------------
//  Supabase project credentials.
//
//  These two values are PUBLIC by design for a static site — they are safe
//  to commit to GitHub. (Access is controlled by Row Level Security in the
//  database, not by hiding these.)
//
//  Where to find them:
//    Supabase Dashboard → Project Settings → API
//      • Project URL          -> SUPABASE_URL
//      • Project API keys: anon / public  -> SUPABASE_ANON_KEY
//
//  Paste your real values below, then commit + push. Cloudflare redeploys
//  automatically and the whole team is pointed at the same database.
//
//  ⚠️  TEAMMATES: once these are filled in, DON'T change them. This is the
//      SHARED team database. Editing or "rotating" these keys points your
//      copy at a different (empty) database and breaks the app for everyone.
//      If the two values below are already filled in, you're done here.
// ---------------------------------------------------------------------

window.SUPABASE_URL = "https://ymxokfqiuncxlubwdabb.supabase.co";
window.SUPABASE_ANON_KEY = "sb_publishable_Qg593P_4xXgWClUwwLnceg_T74KIu_Y";
