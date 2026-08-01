// POST /api/ai-call-connect
// Body: { call_id }
// Header: Authorization: Bearer <customer's Supabase access token>
//
// Phase 4.6: called when a customer's call has gone unanswered by
// staff and they (or the ring-timeout logic, in Phase 4.6c) choose to
// talk to the AI instead. This endpoint:
//   1. Confirms the call is real, still waiting, and AI-answering is
//      enabled by the store (abos_chat_ai_call_settings.enabled).
//   2. Creates the LiveKit room for this call and explicitly
//      dispatches the AI agent into it.
//   3. Marks the call row answered_by_ai = true.
//   4. Returns a LiveKit join token for the customer's browser.
//
// Idempotent — safe to call twice for the same call_id (e.g. a retry
// after a flaky network) because it checks livekit_room first and,
// if already set, skips straight to re-issuing a token for the
// existing room instead of dispatching a second agent into it.
//
// NOTE (Phase 4.6a scope): this endpoint alone does not produce a
// spoken reply — the agent worker in /abos-chat-ai-agent must be
// deployed and running on LiveKit Cloud (Phase 4.6b) for anything to
// actually happen once the customer joins the room.
import { supabaseServer } from "./_lib/supabaseServer.js";
import { verifyCallerForConversation } from "./_lib/verifyCaller.js";
import { createLiveKitToken, ensureRoom, dispatchAgent, getPublicLiveKitUrl } from "./_lib/livekitServer.js";
import { captureServerError } from "./_lib/sentryServer.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { call_id } = req.body || {};
  if (!call_id) return res.status(400).json({ error: "call_id is required" });

  try {
    const supabase = supabaseServer();

    const { data: call, error: callErr } = await supabase
      .from("abos_chat_calls")
      .select("id, conversation_id, caller_id, caller_role, status, answered_by_ai, livekit_room")
      .eq("id", call_id)
      .maybeSingle();

    if (callErr || !call) return res.status(404).json({ error: "Call not found" });

    const auth = await verifyCallerForConversation(req, call.conversation_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });

    if (!call.answered_by_ai && !["ringing", "waiting"].includes(call.status)) {
      return res.status(409).json({ error: "Call is no longer waiting to be answered" });
    }

    const { data: settings } = await supabase
      .from("abos_chat_ai_call_settings")
      .select("*")
      .eq("id", true)
      .maybeSingle();

    if (!settings?.enabled) {
      return res.status(403).json({ error: "AI call answering is not enabled by the store" });
    }

    const roomName = call.livekit_room || `aicall-${call.id}`;

    const { data: profile } = await supabase
      .from("abos_chat_profiles")
      .select("id, name, customer_number, preferred_language")
      .eq("id", call.caller_id)
      .maybeSingle();

    if (!call.livekit_room) {
      await ensureRoom(roomName, { call_id: call.id, conversation_id: call.conversation_id });

      await dispatchAgent(roomName, "abos-chat-ai-caller", {
        call_id: call.id,
        conversation_id: call.conversation_id,
        customer_id: call.caller_id,
        customer_name: profile?.name || profile?.customer_number || "Customer",
        preferred_language: profile?.preferred_language || null,
        voice_ur: settings.voice_ur,
        voice_en: settings.voice_en,
        greeting_ur: settings.greeting_ur,
        greeting_en: settings.greeting_en,
      });

      await supabase
        .from("abos_chat_calls")
        .update({
          answered_by_ai: true,
          livekit_room: roomName,
          status: "active",
          answered_at: new Date().toISOString(),
        })
        .eq("id", call.id);
    }

    const token = await createLiveKitToken({
      identity: call.caller_id,
      name: profile?.name || profile?.customer_number || "Customer",
      room: roomName,
    });

    return res.status(200).json({ room: roomName, token, livekit_url: getPublicLiveKitUrl() });
  } catch (err) {
    captureServerError("ai-call-connect", err, { call_id });
    console.error("[ai-call-connect] failed:", err);
    return res.status(500).json({ error: "Failed to connect AI to call" });
  }
}
