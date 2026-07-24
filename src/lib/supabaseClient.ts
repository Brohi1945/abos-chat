
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Loud in dev — a missing .env is the #1 cause of "nothing works".
  console.error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill in the SAME Supabase project ABOS uses."
  );
}

export const supabase = createClient(url, anonKey);

// Private Realtime channels (used for call signaling) authorize using
// the current JWT. Keep Realtime's copy of it in sync on login, logout,
// and token refresh so private-channel auth never lags behind.
supabase.auth.onAuthStateChange((_event, session) => {
  supabase.realtime.setAuth(session?.access_token ?? null);
});

