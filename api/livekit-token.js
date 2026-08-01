// POST /api/livekit-token
// Body: { room }
// Header: Authorization: Bearer <token>
//
// Issues a fresh LiveKit join token for an ALREADY-active AI call room.
// Two use cases:
//   1. The customer's browser reconnects mid AI-call (tab refresh,
//      network drop) and needs a new token to rejoin the same room.
//   2. A staff member (owner/agent) wants to silently listen in on a
//      live AI call — issued subscribe-only (canPublish: false), so
//      staff can never accidentally speak into a call the AI is
//      handling.
//
// This does NOT create rooms or dispatch the agent — that only ever
// happens once, in ai-call-connect.js. This is purely "give me a way
// back in to a room that already exists."
import { supabaseServer } from "./_lib/supabaseServer.js";
import { verifyCallerForConversation } from "./_lib/verifyCaller.js";
import { createLiveKitToken, getPublicLiveKitUrl } from "./_lib/livekitServer.js";
import { captureServerError } from "./_lib/sentryServer.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { room } = req.body || {};
  if (!room || !room.startsWith("aicall-")) {
    return res.status(400).json({ error: "A valid AI-call room name is required" });
  }

  try {
    const supabase = supabaseServer();
    const callId = room.replace(/^aicall-/, "");

    const { data: call } = await supabase
      .from("abos_chat_calls")
      .select("id, conversation_id, caller_id, livekit_room, status")
      .eq("id", callId)
      .maybeSingle();

    if (!call || call.livekit_room !== room) {
      return res.status(404).json({ error: "AI call room not found" });
    }

    const authHeader = req.headers.authorization || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "");
    const { data: userData } = await supabase.auth.getUser(accessToken);
    const callerId = userData?.user?.id;
    if (!callerId) return res.status(401).json({ error: "Invalid or expired session" });

    const isCustomer = callerId === call.caller_id;
    const staffAuth = isCustomer ? { ok: false } : await verifyCallerForConversation(req, call.conversation_id);

    if (!isCustomer && !staffAuth.ok) {
      return res.status(403).json({ error: "Not a participant in this call" });
    }

    const { data: profile } = await supabase
      .from("abos_chat_profiles")
      .select("name, customer_number")
      .eq("id", callerId)
      .maybeSingle();

    const jwt = await createLiveKitToken({
      identity: callerId,
      name: profile?.name || profile?.customer_number || "User",
      room,
      // Staff joining to listen in never publish audio into a live AI call.
      canPublish: isCustomer,
      canSubscribe: true,
    });

    return res.status(200).json({ room, token: jwt, livekit_url: getPublicLiveKitUrl() });
  } catch (err) {
    captureServerError("livekit-token", err, { room });
    console.error("[livekit-token] failed:", err);
    return res.status(500).json({ error: "Failed to issue LiveKit token" });
  }
}
