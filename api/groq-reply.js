// POST /api/groq-reply
// Body: { conversationId: string }
// Header: x-abos-chat-webhook-secret: <shared secret>
//
// Phase 1 change: this endpoint is now called ONLY by a Postgres
// trigger (see supabase/migration_ai_reply_webhook.sql), via pg_net,
// whenever a customer sends a text message on a conversation with
// ai_mode = true. It is never called directly by the browser anymore.
//
// Because the caller is our own database and not a person, auth here
// is a shared secret (stored in Supabase Vault on the DB side, and in
// this Vercel project's AI_REPLY_WEBHOOK_SECRET env var) instead of a
// user session token. This shrinks the endpoint's attack surface
// compared to Phase 0 — it no longer needs to accept or verify
// arbitrary authenticated user requests at all.
import { supabaseServer } from "./_lib/supabaseServer.js";
import { callGroqChat } from "./_lib/groqClient.js";

const SYSTEM_PROMPT = `You are a friendly, concise customer-support assistant for a small retail store using ABOS.
Reply in the same language/style the customer used (Roman Urdu/Hindi mix, English, or a mix — mirror them).
Keep replies short (1-4 sentences), warm, and helpful. You do not have live access to inventory or order
status in this conversation — if asked something you can't verify, say a team member will confirm shortly
rather than guessing. Never invent prices, stock levels, or order details.`;

const BOT_NAME = "ABOS Assistant";
const MIN_SECONDS_BETWEEN_AI_REPLIES = 20;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // ---- Auth: shared secret from the DB trigger, not a user JWT. ----
    const expectedSecret = process.env.AI_REPLY_WEBHOOK_SECRET;
    if (!expectedSecret) {
      res.status(500).json({ error: "AI_REPLY_WEBHOOK_SECRET is not set in Vercel environment variables" });
      return;
    }
    const incomingSecret = req.headers["x-abos-chat-webhook-secret"];
    if (!incomingSecret || incomingSecret !== expectedSecret) {
      res.status(401).json({ error: "Invalid or missing webhook secret" });
      return;
    }

    const { conversationId } = req.body || {};
    if (!conversationId) {
      res.status(400).json({ error: "conversationId is required" });
      return;
    }

    const supabase = supabaseServer();

    const { data: conversation, error: convoErr } = await supabase
      .from("abos_chat_conversations")
      .select("id, ai_mode")
      .eq("id", conversationId)
      .maybeSingle();

    if (convoErr || !conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    if (!conversation.ai_mode) {
      // ai_mode may have been flipped off between the trigger firing
      // and this request landing — re-check server-side, no-op if so.
      res.status(200).json({ skipped: true, reason: "ai_mode is off" });
      return;
    }

    // ---- Basic rate limit: don't fire twice within a short window,
    // in case of a duplicate/replayed trigger call. ----
    const since = new Date(Date.now() - MIN_SECONDS_BETWEEN_AI_REPLIES * 1000).toISOString();
    const { data: recentAiReply } = await supabase
      .from("abos_chat_messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("is_ai", true)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle();

    if (recentAiReply) {
      res.status(200).json({ skipped: true, reason: "rate limited" });
      return;
    }

    const { data: recentMessages } = await supabase
      .from("abos_chat_messages")
      .select("sender_role, kind, body, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(12);

    const history = (recentMessages || [])
      .reverse()
      .filter((m) => m.kind === "text" && m.body)
      .map((m) => ({ role: m.sender_role === "customer" ? "user" : "assistant", content: m.body }));

    if (history.length === 0) {
      res.status(200).json({ skipped: true, reason: "no text messages to reply to" });
      return;
    }

    const reply = await callGroqChat(SYSTEM_PROMPT, history);
    if (!reply) {
      res.status(200).json({ skipped: true, reason: "empty reply from model" });
      return;
    }

    // Find the bot's profile row to satisfy the messages table's
    // sender_id foreign key.
    let { data: botProfile } = await supabase
      .from("abos_chat_profiles")
      .select("id")
      .eq("name", BOT_NAME)
      .eq("role", "owner")
      .maybeSingle();

    if (!botProfile) {
      res.status(500).json({
        error: "No bot profile found. Run supabase/migration_ai_replies.sql (see README) before enabling AI mode.",
      });
      return;
    }

    const { error: insertErr } = await supabase.from("abos_chat_messages").insert({
      conversation_id: conversationId,
      sender_id: botProfile.id,
      sender_role: "owner",
      kind: "text",
      body: reply,
      is_ai: true,
    });

    if (insertErr) {
      res.status(500).json({ error: insertErr.message });
      return;
    }

    await supabase
      .from("abos_chat_conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conversationId);

    res.status(200).json({ ok: true, reply });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Internal error" });
  }
}
