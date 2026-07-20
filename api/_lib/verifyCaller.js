// Verifies the Supabase access token sent by the browser and checks
// that the caller is actually allowed to trigger an AI reply for the
// given conversation — either the customer who owns it, or a store
// owner. Prevents random/unauthenticated callers from hitting this
// endpoint directly and running up the Groq bill.
import { supabaseServer } from "./supabaseServer.js";

/**
 * @returns {Promise<{ ok: true } | { ok: false, status: number, message: string }>}
 */
export async function verifyCallerForConversation(req, conversationId) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return { ok: false, status: 401, message: "Missing Authorization header" };
  }

  const supabase = supabaseServer();

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    return { ok: false, status: 401, message: "Invalid or expired session" };
  }
  const callerId = userData.user.id;

  const { data: profile } = await supabase
    .from("abos_chat_profiles")
    .select("role")
    .eq("id", callerId)
    .maybeSingle();

  if (profile?.role === "owner") {
    return { ok: true };
  }

  const { data: conversation } = await supabase
    .from("abos_chat_conversations")
    .select("customer_id")
    .eq("id", conversationId)
    .maybeSingle();

  if (conversation?.customer_id === callerId) {
    return { ok: true };
  }

  return { ok: false, status: 403, message: "Not a participant in this conversation" };
}
