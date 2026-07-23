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
  // IMPORTANT: the Authorization header must be attached at client-creation
  // time. getUser(token) below only verifies the token itself — it does
  // NOT set the client's request context. Without this header, the
  // .from() query further down runs as the anonymous role, auth.uid()
  // resolves to NULL, RLS silently hides the row, and a real owner gets
  // wrongly rejected as "not an owner" (403) instead of being recognized.
  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

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

/** Same as verifyOwner, but also accepts 'agent' — used by endpoints
 *  that agents should be able to use too (e.g. the admin AI assistant),
 *  unlike strictly owner-only endpoints. */
export async function verifyStaff(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, status: 401, message: "Missing Authorization header" };

  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  // Same fix as verifyOwner above — attach the token so RLS sees the
  // real caller instead of treating the query as anonymous.
  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData.user) {
    return { ok: false, status: 401, message: "Invalid or expired session" };
  }

  const { data: profile } = await supabase
    .from("abos_chat_profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (!profile || (profile.role !== "owner" && profile.role !== "agent")) {
    return { ok: false, status: 403, message: "Owner or agent access required" };
  }

  return { ok: true, userId: userData.user.id, role: profile.role };
}
