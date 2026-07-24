
// ============================================================
//  src/lib/callApi.ts
//  Complete Call API — Phase 1 to 7
//  - Create/Claim/End calls
//  - Rate limiting (Phase 4)
//  - Call waiting (Phase 6)
// ============================================================

import { supabase } from "./supabaseClient";
import { Profile, Call, CallKind, CallStatus } from "./types";

function chatRoleOf(me: Profile): "customer" | "owner" {
  return me.role === "customer" ? "customer" : "owner";
}

// ============================================================
//  PHASE 4: Rate Limiting
// ============================================================

const MAX_CALLS_PER_MINUTE = 3;

async function checkRateLimit(userId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('abos_chat_calls')
    .select('id', { count: 'exact', head: true })
    .eq('caller_id', userId)
    .eq('status', 'ringing')
    .gt('created_at', new Date(Date.now() - 60000).toISOString());

  if (error) {
    console.error('Rate limit check error:', error);
    return true; // Allow on error
  }

  if ((count || 0) >= MAX_CALLS_PER_MINUTE) {
    return false;
  }
  return true;
}

// ============================================================
//  Create Call
// ============================================================

export async function createCall(
  conversationId: string,
  me: Profile,
  kind: CallKind
): Promise<Call | null> {
  // ---- PHASE 4: Rate Limit Check ----
  const allowed = await checkRateLimit(me.id);
  if (!allowed) {
    throw new Error('Too many calls. Please wait a moment before calling again.');
  }

  const { data, error } = await supabase
    .from("abos_chat_calls")
    .insert({
      conversation_id: conversationId,
      caller_id: me.id,
      caller_role: chatRoleOf(me),
      kind,
      status: 'ringing',
    })
    .select("*")
    .single();

  if (error) {
    console.error('Create call error:', error);
    return null;
  }

  // ---- PHASE 6: Check if user is already on a call ----
  if (me.role === 'customer') {
    // Check for active calls in this conversation
    const { data: activeCall } = await supabase
      .from('abos_chat_calls')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
      .maybeSingle();

    if (activeCall) {
      // Mark this call as waiting
      await supabase
        .from('abos_chat_calls')
        .update({ status: 'waiting' })
        .eq('id', data.id);
    }
  }

  return data as Call;
}

// ============================================================
//  Claim Call
// ============================================================

export async function claimCall(callId: string, me: Profile): Promise<boolean> {
  // ---- PHASE 6: Check if caller is already on another call ----
  const { data: existingCall } = await supabase
    .from('abos_chat_calls')
    .select('id')
    .eq('answered_by', me.id)
    .eq('status', 'active')
    .maybeSingle();

  if (existingCall) {
    // User is already on a call — reject this one
    return false;
  }

  const { data, error } = await supabase
    .from("abos_chat_calls")
    .update({
      status: "active",
      answered_by: me.id,
      answered_at: new Date().toISOString(),
    })
    .eq("id", callId)
    .eq("status", "ringing")
    .select("id");

  if (error) {
    console.error('Claim call error:', error);
    return false;
  }

  // Update user's on_call status
  if (data && data.length > 0) {
    await supabase
      .from('abos_chat_profiles')
      .update({ on_call: true, current_call_id: callId })
      .eq('id', me.id);
  }

  return (data || []).length > 0;
}

// ============================================================
//  End Call
// ============================================================

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export async function endCall(
  call: Call,
  status: Exclude<CallStatus, "ringing" | "active" | "waiting">,
  me: Profile
): Promise<void> {
  const endedAt = new Date();
  const startedAt = call.answered_at ? new Date(call.answered_at) : null;
  const durationSeconds = startedAt
    ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))
    : null;

  await supabase
    .from("abos_chat_calls")
    .update({
      status,
      ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds,
    })
    .eq("id", call.id)
    .in("status", ["ringing", "active", "waiting"]);

  // Clear user's on_call status
  await supabase
    .from('abos_chat_profiles')
    .update({ on_call: false, current_call_id: null })
    .eq('id', me.id);

  if (call.answered_by) {
    await supabase
      .from('abos_chat_profiles')
      .update({ on_call: false, current_call_id: null })
      .eq('id', call.answered_by);
  }

  const kindLabel = call.kind === "video" ? "Video" : "Voice";
  const label =
    status === "missed"
      ? `Missed ${call.kind} call`
      : status === "declined"
      ? `Declined ${call.kind} call`
      : durationSeconds != null
      ? `${kindLabel} call · ${formatDuration(durationSeconds)}`
      : `${kindLabel} call`;

  await supabase.from("abos_chat_messages").insert({
    conversation_id: call.conversation_id,
    sender_id: call.caller_id,
    sender_role: call.caller_role,
    kind: "call",
    body: label,
    call_id: call.id,
  });

  await supabase
    .from("abos_chat_conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", call.conversation_id);
}

// ============================================================
//  Get Profile Name
// ============================================================

export async function getProfileName(id: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("abos_chat_profiles")
    .select("name, email")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) return null;
  return data.name || data.email || null;
}

// ============================================================
//  Subscribe to Incoming Calls
// ============================================================

export function subscribeToIncomingCalls(
  me: Profile,
  myConversationId: string | null,
  onRinging: (call: Call) => void
) {
  const channel = supabase
    .channel(`incoming-calls-${me.id}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "abos_chat_calls" },
      (payload) => {
        const call = payload.new as Call;
        if (call.caller_id === me.id) return;

        // ---- PHASE 6: Check for waiting calls ----
        if (call.status === 'waiting') {
          // Show "busy" notification
          // We'll handle this in CallManager
          onRinging(call);
          return;
        }

        if (me.role === "customer") {
          if (call.conversation_id !== myConversationId) return;
        } else if (call.caller_role !== "customer") {
          return;
        }
        onRinging(call);
      }
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}

// ============================================================
//  Subscribe to Call Row
// ============================================================

export function subscribeToCallRow(callId: string, onUpdate: (call: Call) => void) {
  const channel = supabase
    .channel(`call-row-${callId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "abos_chat_calls", filter: `id=eq.${callId}` },
      (payload) => onUpdate(payload.new as Call)
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}

// ============================================================
//  WebRTC Signaling
// ============================================================

export type SignalMessage =
  | { type: "offer"; sdp: RTCSessionDescriptionInit; from: string }
  | { type: "answer"; sdp: RTCSessionDescriptionInit; from: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit; from: string }
  | { type: "hangup"; from: string };

export function openCallSignalChannel(
  callId: string,
  myId: string,
  onMessage: (msg: SignalMessage) => void
) {
  const channel = supabase.channel(`call-signal-${callId}`, {
    config: { broadcast: { self: false }, private: true },
  });

  channel.on("broadcast", { event: "signal" }, ({ payload }) => {
    const msg = payload as SignalMessage;
    if (msg.from === myId) return;
    onMessage(msg);
  });

  channel.subscribe();

  const send = (msg: SignalMessage) =>
    channel.send({ type: "broadcast", event: "signal", payload: msg });
  const unsubscribe = () => supabase.removeChannel(channel);

  return { send, unsubscribe };
}

