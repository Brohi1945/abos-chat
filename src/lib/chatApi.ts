// ============================================================
//  src/lib/chatApi.ts
//  Complete Chat API — Phase 1 to 8
//  - Messages, conversations, broadcasts
//  - Message queue (Phase 5)
//  - Read receipts (Phase 5), now with a real read_at timestamp (Phase 8)
//  - Reply/quote, edit, soft-delete, pin, reactions, canned
//    responses, in-chat search (Phase 8 — Quick Wins)
// ============================================================

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
  MessageReaction,
  CannedResponse,
} from "./types";

// ============================================================
//  Auth
// ============================================================

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
    const { data, error } = await supabase
      .from("abos_chat_profiles")
      .select("*")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (data) return data as Profile;
    if (error) console.error(error);
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// ============================================================
//  Staff Identity Helper
// ============================================================

function staffIdentity(me: Profile): {
  senderName?: string;
  senderTitle?: "Owner" | "Agent";
} {
  if (me.role === "customer") return {};
  return {
    senderName: me.name || me.email || undefined,
    senderTitle: me.role === "owner" ? "Owner" : "Agent",
  };
}

// ============================================================
//  Conversations
// ============================================================

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

export async function getOwnerInbox(): Promise<OwnerInboxRow[]> {
  const { data, error } = await supabase.rpc("abos_chat_owner_inbox");
  if (error) {
    console.error(error);
    return [];
  }
  return (data || []) as OwnerInboxRow[];
}

export async function searchConversations(term: string): Promise<OwnerInboxRow[]> {
  const { data, error } = await supabase.rpc("abos_chat_search_conversations", { term });
  if (error) {
    console.error(error);
    return [];
  }
  return (data || []) as OwnerInboxRow[];
}

export async function updateConversationStatus(conversationId: string, status: ConversationStatus) {
  const { error } = await supabase
    .from("abos_chat_conversations")
    .update({ status })
    .eq("id", conversationId);
  if (error) console.error(error);
  return !error;
}

export async function updateConversationTags(conversationId: string, tags: string[]) {
  const { error } = await supabase
    .from("abos_chat_conversations")
    .update({ tags })
    .eq("id", conversationId);
  if (error) console.error(error);
  return !error;
}

// ============================================================
//  Broadcast
// ============================================================

export async function sendBroadcast(
  me: Profile,
  body: string,
  targetTag?: string
): Promise<boolean> {
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

// ============================================================
//  Messages
// ============================================================

const MESSAGES_PAGE_SIZE = 30;

export interface MessagesPage {
  messages: ChatMessage[];
  hasMore: boolean;
}

export async function getMessageById(messageId: string): Promise<ChatMessage | null> {
  const { data, error } = await supabase
    .from("abos_chat_messages")
    .select("*")
    .eq("id", messageId)
    .maybeSingle();
  if (error) {
    console.error(error);
    return null;
  }
  return data as ChatMessage | null;
}

export async function listMessages(
  conversationId: string,
  before?: string
): Promise<MessagesPage> {
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

// ============================================================
//  Send Message (with retry/queue support)
// ============================================================

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
  // Phase 8: reply/quote — id of the message being replied to
  replyToId?: string;
}

// ---- PHASE 5: Message Queue ----
async function addToMessageQueue(input: SendMessageInput): Promise<void> {
  const { error } = await supabase
    .from('abos_chat_message_queue')
    .insert({
      user_id: input.senderId,
      conversation_id: input.conversationId,
      message_data: input,
      status: 'pending',
      max_attempts: 5,
      next_retry_at: new Date().toISOString(),
    });

  if (error) {
    console.error('Failed to add message to queue:', error);
  }
}

// ---- PHASE 5: Process message queue ----
export async function processMessageQueue(userId: string): Promise<void> {
  const { data: pendingMessages, error } = await supabase
    .from('abos_chat_message_queue')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .lt('next_retry_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(10);

  if (error || !pendingMessages) {
    console.error('Error fetching queue:', error);
    return;
  }

  for (const item of pendingMessages) {
    try {
      // Mark as sending
      await supabase
        .from('abos_chat_message_queue')
        .update({ status: 'sending', updated_at: new Date().toISOString() })
        .eq('id', item.id);

      const input = item.message_data as SendMessageInput;
      const result = await sendMessageDirect(input);

      if (result) {
        // Success — remove from queue
        await supabase
          .from('abos_chat_message_queue')
          .delete()
          .eq('id', item.id);
      } else {
        // Failed — increment attempts and schedule retry
        const newAttempts = (item.attempts || 0) + 1;
        if (newAttempts >= (item.max_attempts || 5)) {
          await supabase
            .from('abos_chat_message_queue')
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('id', item.id);
        } else {
          const delay = Math.pow(2, newAttempts) * 1000;
          await supabase
            .from('abos_chat_message_queue')
            .update({
              attempts: newAttempts,
              next_retry_at: new Date(Date.now() + delay).toISOString(),
              status: 'pending',
              updated_at: new Date().toISOString(),
            })
            .eq('id', item.id);
        }
      }
    } catch (err) {
      console.error('Queue processing error:', err);
    }
  }
}

// ---- Direct send (used by queue) ----
async function sendMessageDirect(input: SendMessageInput): Promise<boolean> {
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
    reply_to_id: input.replyToId ?? null,
    delivery_status: 'sent',
  });

  if (error) {
    console.error('Send message error:', error);
    return false;
  }

  await supabase
    .from("abos_chat_conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", input.conversationId);

  return true;
}

// ---- Public send message (with retry) ----
export async function sendMessage(input: SendMessageInput): Promise<boolean> {
  try {
    const result = await sendMessageDirect(input);
    if (!result) {
      // If direct send fails, add to queue
      await addToMessageQueue(input);
      console.log('Message queued for retry:', input);
    }
    return result;
  } catch (err) {
    // If error, add to queue
    await addToMessageQueue(input);
    console.log('Message queued for retry due to error:', err);
    return false;
  }
}

// ============================================================
//  Mark Messages Read (Phase 5, real timestamp added in Phase 8)
// ============================================================

export async function markMessagesRead(conversationId: string, userId: string): Promise<void> {
  try {
    await supabase.rpc('abos_chat_mark_messages_read', {
      p_conversation_id: conversationId,
      p_reader_id: userId,
    });
  } catch (err) {
    console.error('Error marking messages read:', err);
  }
}

// ============================================================
//  Phase 8: Edit / Delete
// ============================================================

export async function editMessage(messageId: string, newBody: string): Promise<boolean> {
  const { error } = await supabase
    .from("abos_chat_messages")
    .update({ body: newBody, edited_at: new Date().toISOString() })
    .eq("id", messageId);
  if (error) {
    console.error("Edit message error:", error);
    return false;
  }
  return true;
}

export async function deleteMessage(messageId: string): Promise<boolean> {
  const { error } = await supabase
    .from("abos_chat_messages")
    .update({
      deleted_at: new Date().toISOString(),
      body: null,
      media_url: null,
    })
    .eq("id", messageId);
  if (error) {
    console.error("Delete message error:", error);
    return false;
  }
  return true;
}

// ============================================================
//  Phase 8: Pin / Unpin
// ============================================================

export async function pinMessage(messageId: string, userId: string): Promise<boolean> {
  const { error } = await supabase
    .from("abos_chat_messages")
    .update({ pinned_at: new Date().toISOString(), pinned_by: userId })
    .eq("id", messageId);
  if (error) {
    console.error("Pin message error:", error);
    return false;
  }
  return true;
}

export async function unpinMessage(messageId: string): Promise<boolean> {
  const { error } = await supabase
    .from("abos_chat_messages")
    .update({ pinned_at: null, pinned_by: null })
    .eq("id", messageId);
  if (error) {
    console.error("Unpin message error:", error);
    return false;
  }
  return true;
}

export async function getPinnedMessages(conversationId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("abos_chat_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .not("pinned_at", "is", null)
    .order("pinned_at", { ascending: false });
  if (error) {
    console.error(error);
    return [];
  }
  return (data || []) as ChatMessage[];
}

// ============================================================
//  Phase 8: Reactions
// ============================================================

export async function getReactionsForMessages(messageIds: string[]): Promise<MessageReaction[]> {
  if (messageIds.length === 0) return [];
  const { data, error } = await supabase
    .from("abos_chat_message_reactions")
    .select("*")
    .in("message_id", messageIds);
  if (error) {
    console.error(error);
    return [];
  }
  return (data || []) as MessageReaction[];
}

// Tap the same emoji again to remove your reaction, tap a different
// one to switch it — one reaction per person per message (matches the
// unique(message_id, user_id) constraint in the DB).
export async function toggleReaction(
  messageId: string,
  userId: string,
  emoji: string,
  existing?: MessageReaction
): Promise<"added" | "removed" | "changed" | "error"> {
  if (existing && existing.emoji === emoji) {
    const { error } = await supabase
      .from("abos_chat_message_reactions")
      .delete()
      .eq("id", existing.id);
    if (error) {
      console.error(error);
      return "error";
    }
    return "removed";
  }

  if (existing) {
    const { error } = await supabase
      .from("abos_chat_message_reactions")
      .update({ emoji })
      .eq("id", existing.id);
    if (error) {
      console.error(error);
      return "error";
    }
    return "changed";
  }

  const { error } = await supabase
    .from("abos_chat_message_reactions")
    .insert({ message_id: messageId, user_id: userId, emoji });
  if (error) {
    console.error(error);
    return "error";
  }
  return "added";
}

export function subscribeToReactions(
  onChange: (payload: {
    eventType: "INSERT" | "UPDATE" | "DELETE";
    reaction: MessageReaction | null;
    oldReaction: MessageReaction | null;
  }) => void
) {
  const channel = supabase
    .channel("message-reactions")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "abos_chat_message_reactions" },
      (payload) => {
        onChange({
          eventType: payload.eventType as "INSERT" | "UPDATE" | "DELETE",
          reaction: (payload.new as MessageReaction) || null,
          oldReaction: (payload.old as MessageReaction) || null,
        });
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// ============================================================
//  Phase 8: In-chat conversation search
// ============================================================

export async function searchMessagesInConversation(
  conversationId: string,
  term: string
): Promise<ChatMessage[]> {
  const trimmed = term.trim();
  if (!trimmed) return [];
  const { data, error } = await supabase
    .from("abos_chat_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .ilike("body", `%${trimmed}%`)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error(error);
    return [];
  }
  return (data || []) as ChatMessage[];
}

// ============================================================
//  Phase 8: Canned responses (shared, shop-wide, staff only)
// ============================================================

export async function listCannedResponses(): Promise<CannedResponse[]> {
  const { data, error } = await supabase
    .from("abos_chat_canned_responses")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) {
    console.error(error);
    return [];
  }
  return (data || []) as CannedResponse[];
}

export async function createCannedResponse(
  userId: string,
  title: string,
  body: string
): Promise<boolean> {
  const { error } = await supabase
    .from("abos_chat_canned_responses")
    .insert({ created_by: userId, title, body });
  if (error) {
    console.error(error);
    return false;
  }
  return true;
}

export async function deleteCannedResponse(id: string): Promise<boolean> {
  const { error } = await supabase.from("abos_chat_canned_responses").delete().eq("id", id);
  if (error) {
    console.error(error);
    return false;
  }
  return true;
}

// ============================================================
//  Product Messages
// ============================================================

export async function sendProductMessage(
  conversationId: string,
  me: Profile,
  product: ProductSnapshot
): Promise<boolean> {
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

// ============================================================
//  Product Search
// ============================================================

export async function searchProducts(query: string): Promise<ProductSnapshot[]> {
  let q = supabase
    .from("products")
    .select("id, name, price, stock, category")
    .order("name")
    .limit(15);

  if (query.trim()) q = q.ilike("name", `%${query.trim()}%`);

  const { data, error } = await q;
  if (error) {
    console.error(error);
    return [];
  }
  return (data || []) as ProductSnapshot[];
}

// ============================================================
//  Linked Orders
// ============================================================

export async function getLinkedOrders(conversationId: string): Promise<LinkedOrder[]> {
  const token = await getAccessToken();
  if (!token) return [];

  try {
    const res = await fetch(
      `/api/customer-orders?conversationId=${encodeURIComponent(conversationId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.orders || []) as LinkedOrder[];
  } catch (err) {
    console.error(err);
    return [];
  }
}

// ============================================================
//  Subscriptions
// ============================================================

export function subscribeToMessages(
  conversationId: string,
  onInsert: (msg: ChatMessage) => void
) {
  const channel = supabase
    .channel(`messages-${conversationId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "abos_chat_messages",
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => onInsert(payload.new as ChatMessage)
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// Phase 8: live updates for edits/deletes/pins on already-loaded
// messages (separate from subscribeToMessages, which only fires on
// INSERT — this covers UPDATE so an edit/delete/pin from one device
// shows up instantly on the other side without a refresh).
export function subscribeToMessageUpdates(
  conversationId: string,
  onUpdate: (msg: ChatMessage) => void
) {
  const channel = supabase
    .channel(`messages-updates-${conversationId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "abos_chat_messages",
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => onUpdate(payload.new as ChatMessage)
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

export async function toggleAiMode(conversationId: string, aiMode: boolean) {
  const { error } = await supabase
    .from("abos_chat_conversations")
    .update({ ai_mode: aiMode })
    .eq("id", conversationId);
  if (error) console.error(error);
  return !error;
}

export async function markConversationRead(
  conversationId: string,
  myRole: "customer" | "owner"
) {
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

export function subscribeToConversation(
  conversationId: string,
  onUpdate: (convo: Conversation) => void
) {
  const channel = supabase
    .channel(`conversation-${conversationId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "abos_chat_conversations",
        filter: `id=eq.${conversationId}`,
      },
      (payload) => onUpdate(payload.new as Conversation)
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// ============================================================
//  Typing Indicator
// ============================================================

export function subscribeToTyping(
  conversationId: string,
  myRole: "customer" | "owner",
  onOtherTyping: (isTyping: boolean) => void
) {
  const channel = supabase.channel(`typing-${conversationId}`, {
    config: { presence: { key: myRole } },
  });

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
      typingTimeout = setTimeout(() => channel.track({ typing: false }), 4000);
    }
  };

  const unsubscribe = () => {
    if (typingTimeout) clearTimeout(typingTimeout);
    supabase.removeChannel(channel);
  };

  return { setTyping, unsubscribe };
}

// ============================================================
//  Storage
// ============================================================

export async function uploadMedia(
  file: File | Blob,
  pathPrefix: string,
  ext: string
): Promise<string | null> {
  const path = `${pathPrefix}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from("abos-chat-media")
    .upload(path, file, { upsert: false });

  if (error) {
    console.error(error);
    return null;
  }

// ============================================================
//  Phase 9 Feature 1: Staff accounts + roles
// ============================================================

export async function listAllProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase
    .from("abos_chat_profiles")
    .select("*")
    .order("role", { ascending: false }) // owner, then agent, then customer
    .order("name", { ascending: true });

  if (error) {
    console.error(error);
    return [];
  }
  return data as Profile[];
}

export async function setStaffRole(targetId: string, newRole: "customer" | "agent"): Promise<boolean> {
  const { error } = await supabase.rpc("abos_chat_set_staff_role", {
    target_id: targetId,
    new_role: newRole,
  });
  if (error) {
    console.error(error);
    return false;
  }
  return true;
}

export async function setStaffActive(targetId: string, isActive: boolean): Promise<boolean> {
  const { error } = await supabase.rpc("abos_chat_set_staff_active", {
    target_id: targetId,
    is_active: isActive,
  });
  if (error) {
    console.error(error);
    return false;
  }
  return true;
}

