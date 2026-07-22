import { supabase } from "./supabaseClient";
import {
  Profile,
  Conversation,
  ChatMessage,
  MessageKind,
  OwnerInboxRow,
  ProductSnapshot,
  LinkedOrder,
  ConversationStatus,
} from "./types";

/** Store-side display identity for whoever is sending — attached as a
 *  snapshot on the message row so it survives renames/deletes and
 *  needs no extra join or RLS opening for customers to read it. */
function staffIdentity(me: Profile): { senderName?: string; senderTitle?: "Owner" | "Agent" } {
  if (me.role === "customer") return {};
  return {
    senderName: me.name || me.email || undefined,
    senderTitle: me.role === "owner" ? "Owner" : "Agent",
  };
}

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

  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await supabase.from("abos_chat_profiles").select("*").eq("id", userData.user.id).maybeSingle();
    if (data) return data as Profile;
    if (error) console.error(error);
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/** Current user's access token, for calling our own /api/* endpoints
 *  that expect "Authorization: Bearer <token>" (owner-only endpoints). */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// ---------- Conversations ----------

/**
 * Gets (or creates) the single conversation thread for a customer.
 * Race-safe via a DB-level UNIQUE constraint on customer_id — see
 * supabase/migration_sync_phase1.sql.
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

/** Owner inbox: every conversation with customer info + unread count,
 *  computed server-side via the abos_chat_owner_inbox() function. */
export async function getOwnerInbox(): Promise<OwnerInboxRow[]> {
  const { data, error } = await supabase.rpc("abos_chat_owner_inbox");
  if (error) {
    console.error(error);
    return [];
  }
  return (data || []) as OwnerInboxRow[];
}

/** Owner-side search across customer name/number/email/tags AND
 *  message content, in one server-side call. Empty term returns the
 *  normal inbox (caller can just fall back to getOwnerInbox instead). */
export async function searchConversations(term: string): Promise<OwnerInboxRow[]> {
  const { data, error } = await supabase.rpc("abos_chat_search_conversations", { term });
  if (error) {
    console.error(error);
    return [];
  }
  return (data || []) as OwnerInboxRow[];
}

export async function updateConversationStatus(conversationId: string, status: ConversationStatus) {
  const { error } = await supabase.from("abos_chat_conversations").update({ status }).eq("id", conversationId);
  if (error) console.error(error);
  return !error;
}

export async function updateConversationTags(conversationId: string, tags: string[]) {
  const { error } = await supabase.from("abos_chat_conversations").update({ tags }).eq("id", conversationId);
  if (error) console.error(error);
  return !error;
}

/** Sends one message to every conversation matching targetTag (or all
 *  conversations if targetTag is omitted) via a single atomic RPC. */
export async function sendBroadcast(me: Profile, body: string, targetTag?: string): Promise<boolean> {
  const identity = staffIdentity(me);
  const { error } = await supabase.rpc("abos_chat_send_broadcast", {
    sender_name: identity.senderName ?? null,
    sender_title: identity.senderTitle ?? null,
    body,
    target_tag: targetTag ?? null,
  });
  if (error) {
    console.error(error);
    return false;
  }
  return true;
}

// ---------- Messages ----------

const MESSAGES_PAGE_SIZE = 30;

export interface MessagesPage {
  messages: ChatMessage[];
  hasMore: boolean;
}

export async function listMessages(conversationId: string, before?: string): Promise<MessagesPage> {
  let query = supabase
    .from("abos_chat_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(MESSAGES_PAGE_SIZE + 1);

  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) {
    console.error(error);
    return { messages: [], hasMore: false };
  }

  const rows = data || [];
  const hasMore = rows.length > MESSAGES_PAGE_SIZE;
  const page = rows.slice(0, MESSAGES_PAGE_SIZE).reverse();
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
  productSnapshot?: ProductSnapshot;
  senderName?: string;
  senderTitle?: "Owner" | "Agent";
}

export async function sendMessage(input: SendMessageInput) {
  const { error } = await supabase.from("abos_chat_messages").insert({
    conversation_id: input.conversationId,
    sender_id: input.senderId,
    sender_role: input.senderRole,
    kind: input.kind,
    body: input.body || null,
    media_url: input.mediaUrl || null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    product_snapshot: input.productSnapshot ?? null,
    sender_name: input.senderName ?? null,
    sender_title: input.senderTitle ?? null,
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

/** Owner/agent sends a product as a rich card — snapshotted at send time. */
export async function sendProductMessage(conversationId: string, me: Profile, product: ProductSnapshot) {
  const identity = staffIdentity(me);
  return sendMessage({
    conversationId,
    senderId: me.id,
    senderRole: "owner",
    kind: "product",
    productSnapshot: product,
    senderName: identity.senderName,
    senderTitle: identity.senderTitle,
  });
}

/** Product search for the owner's "send product" picker. The `products`
 *  table has a public SELECT policy in ABOS (storefront needs it), so
 *  this works with the normal anon-key client — no server endpoint
 *  needed for reading products. */
export async function searchProducts(query: string): Promise<ProductSnapshot[]> {
  let q = supabase.from("products").select("id, name, price, stock, category").order("name").limit(15);
  if (query.trim()) q = q.ilike("name", `%${query.trim()}%`);
  const { data, error } = await q;
  if (error) {
    console.error(error);
    return [];
  }
  return (data || []) as ProductSnapshot[];
}

/** Best-effort ABOS orders matched to this conversation's customer by
 *  email (there's no formal link between the two systems — see
 *  api/customer-orders.js). Owner-only; goes through a server endpoint
 *  using the service-role key rather than direct client table access. */
export async function getLinkedOrders(conversationId: string): Promise<LinkedOrder[]> {
  const token = await getAccessToken();
  if (!token) return [];
  try {
    const res = await fetch(`/api/customer-orders?conversationId=${encodeURIComponent(conversationId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.orders || []) as LinkedOrder[];
  } catch (err) {
    console.error(err);
    return [];
  }
}

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

export async function toggleAiMode(conversationId: string, aiMode: boolean) {
  const { error } = await supabase.from("abos_chat_conversations").update({ ai_mode: aiMode }).eq("id", conversationId);
  if (error) console.error(error);
  return !error;
}

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

// ---------- Typing indicator (Supabase Presence) ----------
// Ephemeral, in-memory only — no table needed. Each side broadcasts
// "I'm typing" on a shared per-conversation presence channel; the
// other side listens. Presence state clears itself automatically if a
// tab closes or the channel disconnects, so there's nothing to clean up.

export function subscribeToTyping(
  conversationId: string,
  myRole: "customer" | "owner",
  onOtherTyping: (isTyping: boolean) => void
) {
  const channel = supabase.channel(`typing-${conversationId}`, { config: { presence: { key: myRole } } });

  const otherKey = myRole === "customer" ? "owner" : "customer";

  channel
    .on("presence", { event: "sync" }, () => {
      const state = channel.presenceState() as Record<string, Array<{ typing: boolean }>>;
      const otherPresence = state[otherKey]?.[0];
      onOtherTyping(!!otherPresence?.typing);
    })
    .subscribe();

  let typingTimeout: ReturnType<typeof setTimeout> | null = null;

  const setTyping = (isTyping: boolean) => {
    channel.track({ typing: isTyping });
    if (typingTimeout) clearTimeout(typingTimeout);
    if (isTyping) {
      // Auto-clear after 4s of no further keystrokes, in case "stopped
      // typing" never fires (tab backgrounded, etc.) — the indicator
      // shouldn't get stuck on forever.
      typingTimeout = setTimeout(() => channel.track({ typing: false }), 4000);
    }
  };

  const unsubscribe = () => {
    if (typingTimeout) clearTimeout(typingTimeout);
    supabase.removeChannel(channel);
  };

  return { setTyping, unsubscribe };
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
