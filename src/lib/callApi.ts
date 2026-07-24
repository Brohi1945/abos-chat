// src/lib/callApi.ts

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
  // NOTE: a Postgres trigger (abos_chat_reap_stale_calls, applied
  // 2026-07-24) now auto-closes any 'ringing'/'waiting' row older than
  // 45s and any 'active' row older than 4h *before* this insert even
  // lands — so a call that died without a clean hangup (tab closed,
  // app killed, crash) can no longer make every future call in this
  // conversation get stuck showing "Already on a call" forever.
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
      const { error: waitingError } = await supabase
        .from('abos_chat_calls')
        .update({ status: 'waiting' })
        .eq('id', data.id);
      if (waitingError) {
        console.error('Failed to mark call as waiting:', waitingError);
      } else {
        (data as any).status = 'waiting';
      }
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

  const { data: endedRows, error: endErr } = await supabase
    .from("abos_chat_calls")
    .update({
      status,
      ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds,
    })
    .eq("id", call.id)
    .in("status", ["ringing", "active", "waiting"])
    .select("id");

  if (endErr) {
    // Previously unchecked — a failed write here (RLS, network blip,
    // race) meant the row stayed "active" forever and the OTHER person's
    // screen would never get the postgres_changes update: their call
    // screen and timer would keep running with no way to know why.
    console.error("endCall: failed to update call row", endErr);
  } else if (!endedRows || endedRows.length === 0) {
    // Row didn't match the filter (already ended by the other side, or
    // doesn't exist) — not necessarily an error, but worth knowing about
    // if hangups seem to "not go through" on one side.
    console.warn("endCall: no row updated for call", call.id, "(already ended?)");
  }

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
//  End-call "beacon" — fires on tab close / app background-kill
// ============================================================
// A normal endCall() (above) is a multi-step async flow: it won't
// reliably finish if the tab is being torn down right now. This is a
// single best-effort fire-and-forget PATCH straight to the REST API
// with `keepalive: true`, so the browser is allowed to complete it even
// after the page has already unloaded. It only flips the row's status —
// it does NOT insert the call-log message or touch profiles (that full
// cleanup still happens normally whenever anyone opens the app next,
// via the reap trigger). Goal: the *other* person sees "call ended"
// within a second or two instead of the call hanging until the 45s/4h
// server-side reap catches it.
export function endCallBeacon(
  callId: string,
  status: "ended" | "missed" | "declined"
): void {
  try {
    const url = (import.meta as any).env.VITE_SUPABASE_URL;
    const anonKey = (import.meta as any).env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anonKey) return;

    const endpoint = `${url}/rest/v1/abos_chat_calls?id=eq.${encodeURIComponent(callId)}&status=in.(ringing,active,waiting)`;

    fetch(endpoint, {
      method: "PATCH",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ status, ended_at: new Date().toISOString() }),
    }).catch(() => {
      // best-effort only — the reap trigger is the real safety net
    });
  } catch {
    // ignore — never let cleanup crash the unload path
  }
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

        // ---- Filter FIRST, for every status (including 'waiting') ----
        // Previously 'waiting' events skipped this check entirely, so a
        // call-waiting notification for someone else's conversation could
        // reach this subscriber too (and IncomingCallBanner rings for
        // 'waiting' calls the same as 'ringing' ones).
        if (me.role === "customer") {
          if (call.conversation_id !== myConversationId) return;
        } else if (call.caller_role !== "customer") {
          return;
        }

        // ---- PHASE 6: 'waiting' just means "already on a call" — the
        // busy notification itself is handled in CallManager.
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
//  Ring acknowledgement — drives "Calling…" vs "Ringing…"
// ============================================================
// WhatsApp-style distinction: the caller shows "Calling…" until we get
// proof the other device actually received the incoming call (i.e. its
// IncomingCallBanner is on screen), then flips to "Ringing…". If the
// other side has no network / the app isn't open, no ack ever arrives,
// so it correctly stays on "Calling…" until the ring times out.

export function subscribeToRingAck(callId: string, onRingAck: () => void) {
  const channel = supabase.channel(`call-ring-${callId}`, {
    config: { broadcast: { self: false } },
  });
  channel.on("broadcast", { event: "ring-ack" }, () => onRingAck());
  channel.subscribe();
  return () => supabase.removeChannel(channel);
}

export function sendRingAck(callId: string): void {
  const channel = supabase.channel(`call-ring-${callId}`, {
    config: { broadcast: { self: false } },
  });
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      channel.send({ type: "broadcast", event: "ring-ack", payload: {} });
      setTimeout(() => supabase.removeChannel(channel), 1500);
    }
  });
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
