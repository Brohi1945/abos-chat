import { supabase } from "./supabaseClient";
import { Profile, Call, CallKind, CallStatus } from "./types";

function chatRoleOf(me: Profile): "customer" | "owner" {
  return me.role === "customer" ? "customer" : "owner";
}

export async function createCall(conversationId: string, me: Profile, kind: CallKind): Promise<Call | null> {
  const { data, error } = await supabase
    .from("abos_chat_calls")
    .insert({ conversation_id: conversationId, caller_id: me.id, caller_role: chatRoleOf(me), kind })
    .select("*")
    .single();
  if (error) {
    console.error(error);
    return null;
  }
  return data as Call;
}

/** Atomically claims a ringing call — only the first person to run
 *  this successfully wins. Matters when several agents see the same
 *  incoming call at once (shared inbox). */
export async function claimCall(callId: string, me: Profile): Promise<boolean> {
  const { data, error } = await supabase
    .from("abos_chat_calls")
    .update({ status: "active", answered_by: me.id, answered_at: new Date().toISOString() })
    .eq("id", callId)
    .eq("status", "ringing")
    .select("id");
  if (error) {
    console.error(error);
    return false;
  }
  return (data || []).length > 0;
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Ends a call — updates its row and drops a call-log message into the
 *  conversation ("Voice call · 2:15", "Missed video call", ...). */
export async function endCall(call: Call, status: Exclude<CallStatus, "ringing" | "active">, me: Profile) {
  const endedAt = new Date();
  const startedAt = call.answered_at ? new Date(call.answered_at) : null;
  const durationSeconds = startedAt
    ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))
    : null;

  await supabase
    .from("abos_chat_calls")
    .update({ status, ended_at: endedAt.toISOString(), duration_seconds: durationSeconds })
    .eq("id", call.id)
    .in("status", ["ringing", "active"]);

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

/** Best-effort display name for an incoming caller — only resolvable
 *  for owner/agent (RLS lets staff read any profile); a customer can
 *  only ever read their own profile, so their incoming-call banner
 *  just says "Store" instead of a staff member's name. */
export async function getProfileName(id: string): Promise<string | null> {
  const { data, error } = await supabase.from("abos_chat_profiles").select("name, email").eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data.name || data.email || null;
}

/** Global incoming-call listener, mounted once at the app root.
 *  Customers only ever hear about calls on their own conversation;
 *  owner/agent hear about every customer-initiated ringing call
 *  (shared inbox) but NOT calls a teammate is making outward. */
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
        if (me.role === "customer") {
          if (call.conversation_id !== myConversationId) return;
        } else if (call.caller_role !== "customer") {
          return; // a teammate's outgoing call — not "incoming" for us
        }
        onRinging(call);
      }
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

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

// ---------- WebRTC signaling (Supabase Realtime Broadcast) ----------
// Offer/answer/ICE candidates are relayed peer-to-peer through a
// per-call broadcast channel — ephemeral, never touches the database.

export type SignalMessage =
  | { type: "offer"; sdp: RTCSessionDescriptionInit; from: string }
  | { type: "answer"; sdp: RTCSessionDescriptionInit; from: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit; from: string }
  | { type: "hangup"; from: string };

export function openCallSignalChannel(callId: string, myId: string, onMessage: (msg: SignalMessage) => void) {
  const channel = supabase.channel(`call-signal-${callId}`, { config: { broadcast: { self: false } } });

  channel.on("broadcast", { event: "signal" }, ({ payload }) => {
    const msg = payload as SignalMessage;
    if (msg.from === myId) return;
    onMessage(msg);
  });

  channel.subscribe();

  const send = (msg: SignalMessage) => channel.send({ type: "broadcast", event: "signal", payload: msg });
  const unsubscribe = () => supabase.removeChannel(channel);

  return { send, unsubscribe };
}
