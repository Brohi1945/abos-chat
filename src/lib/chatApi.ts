import { supabase } from "./supabaseClient";
import { Profile, Conversation, ChatMessage, MessageKind } from "./types";

// ---------- Auth ----------

export async function signUp(email: string, password: string, name: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
  return { data, error };
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return { data, error };
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getCurrentProfile(): Promise<Profile | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return null;

  // Profile row is created by a DB trigger on signup; poll briefly in case
  // of a race on the very first load right after signup.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await supabase.from("abos_chat_profiles").select("*").eq("id", userData.user.id).maybeSingle();
    if (data) return data as Profile;
    if (error) console.error(error);
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

// ---------- Conversations ----------

/**
 * Gets (or creates) the single conversation thread for a customer.
 *
 * Race-safe: abos_chat_conversations.customer_id has a DB-level UNIQUE
 * constraint (see supabase/migration_sync_phase1.sql). If two tabs both
 * land here at once with no existing conversation, both will attempt an
 * INSERT — one wins, the other gets a 23505 unique-violation error
 * instead of silently creating a second conversation row. We catch that
 * specific error and just fetch the row the other tab created.
 */
export async function getOrCreateMyConversation(customerId: string): Promise<Conversation | null> {
  const { data: existing } = await supabase
    .from("abos_chat_conversations")
    .select("*")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (existing) return existing as Conversation;

  const { data: created, error } = await supabase
    .from("abos_chat_conversations")
    .insert({ customer_id: customerId })
    .select("*")
    .single();

  if (!error) return created as Conversation;

  if (error.code === "23505") {
    // Another tab won the race between our SELECT and this INSERT —
    // expected, not a real failure. Fetch the conversation it created.
    const { data: theirs } = await supabase
      .from("abos_chat_conversations")
      .select("*")
      .eq("customer_id", customerId)
      .maybeSingle();
    if (theirs) return theirs as Conversation;
  }

  console.error(error);
  return null;
}

/** Owner inbox: every conversation, newest activity first, with customer info joined in. */
export async function listAllConversations(): Promise<Conversation[]> {
  const { data, error } = await supabase
    .from("abos_chat_conversations")
    .select("*, customer:abos_chat_profiles!abos_chat_conversations_customer_id_fkey(*)")
    .order("last_message_at", { ascending: false });
  if (error) {
    console.error(error);
    return [];
  }
  return (data || []) as Conversation[];
}

// ---------- Messages ----------

const MESSAGES_PAGE_SIZE = 30;

export interface MessagesPage {
  /** Oldest-first, ready to render as-is. */
  messages: ChatMessage[];
  /** True if there are older messages beyond this page. */
  hasMore: boolean;
}

/**
 * Loads one page of messages, newest MESSAGES_PAGE_SIZE by default.
 * Pass `before` (an ISO timestamp — typically the created_at of the
 * currently-oldest loaded message) to page further back for a
 * "load earlier messages" control. Without a `before`, this always
 * gets the most recent page, which is what the initial chat load and
 * the realtime-fallback poll both want.
 */
export async function listMessages(conversationId: string, before?: string): Promise<MessagesPage> {
  let query = supabase
    .from("abos_chat_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(MESSAGES_PAGE_SIZE + 1); // fetch one extra just to detect "hasMore"

  if (before) {
    query = query.lt("created_at", before);
  }

  const { data, error } = await query;
  if (error) {
    console.error(error);
    return { messages: [], hasMore: false };
  }

  const rows = data || [];
  const hasMore = rows.length > MESSAGES_PAGE_SIZE;
  const page = rows.slice(0, MESSAGES_PAGE_SIZE).reverse(); // oldest-first for rendering
  return { messages: page, hasMore };
}

interface SendMessageInput {
  conversationId: string;
  senderId: string;
  senderRole: "customer" | "owner";
  kind: MessageKind;
  body?: string;
  mediaUrl?: string;
  lat?: number;
  lng?: number;
}

export async function sendMessage(input: SendMessageInput) {
  // Note: AI auto-reply is no longer triggered from here. A Postgres
  // trigger (supabase/migration_ai_reply_webhook.sql) fires server-side
  // on insert into abos_chat_messages when ai_mode is on, so nothing
  // extra needs to happen client-side after this insert.
  const { error } = await supabase.from("abos_chat_messages").insert({
    conversation_id: input.conversationId,
    sender_id: input.senderId,
    sender_role: input.senderRole,
    kind: input.kind,
    body: input.body || null,
    media_url: input.mediaUrl || null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
  });
  if (error) {
    console.error(error);
    return false;
  }
  await supabase
    .from("abos_chat_conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", input.conversationId);
  return true;
}

/** Subscribes to new messages on a conversation in real time. Returns an unsubscribe fn. */
export function subscribeToMessages(conversationId: string, onInsert: (msg: ChatMessage) => void) {
  const channel = supabase
    .channel(`messages-${conversationId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "abos_chat_messages", filter: `conversation_id=eq.${conversationId}` },
      (payload) => onInsert(payload.new as ChatMessage)
    )
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

/** Owner flips AI auto-reply on/off for one conversation. */
export async function toggleAiMode(conversationId: string, aiMode: boolean) {
  const { error } = await supabase.from("abos_chat_conversations").update({ ai_mode: aiMode }).eq("id", conversationId);
  if (error) console.error(error);
  return !error;
}

/**
 * Marks "now" as the last-read time for whichever side I am. This is
 * what powers the WhatsApp-style blue double-tick on the OTHER side:
 * once they've called this, any of MY messages with created_at before
 * this timestamp render as "read" for me.
 */
export async function markConversationRead(conversationId: string, myRole: "customer" | "owner") {
  const column = myRole === "customer" ? "customer_last_read_at" : "owner_last_read_at";
  const { error } = await supabase
    .from("abos_chat_conversations")
    .update({ [column]: new Date().toISOString() })
    .eq("id", conversationId);
  if (error) console.error(error);
}

export async function getConversation(conversationId: string): Promise<Conversation | null> {
  const { data, error } = await supabase
    .from("abos_chat_conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) {
    console.error(error);
    return null;
  }
  return data as Conversation;
}

/** Subscribes to changes on the conversation row itself (ai_mode toggles,
 *  and — importantly — the other side's last_read_at ticking forward so
 *  read receipts update live without a refresh). */
export function subscribeToConversation(conversationId: string, onUpdate: (convo: Conversation) => void) {
  const channel = supabase
    .channel(`conversation-${conversationId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "abos_chat_conversations", filter: `id=eq.${conversationId}` },
      (payload) => onUpdate(payload.new as Conversation)
    )
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

// ---------- Storage (images / voice notes) ----------

export async function uploadMedia(file: File | Blob, pathPrefix: string, ext: string): Promise<string | null> {
  const path = `${pathPrefix}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("abos-chat-media").upload(path, file, { upsert: false });
  if (error) {
    console.error(error);
    return null;
  }
  const { data } = supabase.storage.from("abos-chat-media").getPublicUrl(path);
  return data.publicUrl;
}
