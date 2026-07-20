// Server-side Supabase client — uses the SERVICE ROLE key so it can
// insert AI-generated messages on the store's behalf, bypassing RLS.
// NEVER import this file into frontend (src/) code — service role key
// must only ever run on the server (Vercel function), never ship to
// the browser.
import { createClient } from "@supabase/supabase-js";

export function supabaseServer() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables");
  }
  return createClient(url, serviceKey);
}
