// Verifies the caller's Supabase session belongs to an owner. Uses the
// anon key + the caller's own JWT (not the service-role key) — RLS on
// abos_chat_profiles already allows a user to read their own row, and
// abos_chat_is_owner() covers the rest, so this is least-privilege: it
// can only ever confirm "is this really an owner", nothing more.
import { createClient } from "@supabase/supabase-js";

export async function verifyOwner(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, status: 401, message: "Missing Authorization header" };

  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const supabase = createClient(url, anonKey);

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData.user) {
    return { ok: false, status: 401, message: "Invalid or expired session" };
  }

  const { data: profile } = await supabase
    .from("abos_chat_profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (!profile || profile.role !== "owner") {
    return { ok: false, status: 403, message: "Owner access required" };
  }

  return { ok: true, userId: userData.user.id };
}
