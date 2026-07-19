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

/** Gets (or creates) the single conversation thread for a customer. */
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
  if (error) {
    console.error(error);
    return null;
  }
  return created as Conversation;
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

export async function listMessages(conversationId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("abos_chat_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error(error);
    return [];
  }
  return (data || []) as ChatMessage[];
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
 * Asks the server to generate + insert a Groq AI reply for this
 * conversation (server checks ai_mode is actually on before doing
 * anything — this call is a no-op if it's off). Fire-and-forget is
 * fine; errors are logged, not thrown, since it should never block
 * the customer's own message from having been sent.
 */
export async function triggerAIReply(conversationId: string) {
  try {
    await fetch("/api/groq-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });
  } catch (err) {
    console.error("AI reply trigger failed", err);
  }
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
