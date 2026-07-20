// POST /api/groq-reply
// Body: { conversationId: string }
//
// Only fires the AI when the conversation has ai_mode = true (checked
// server-side, not trusted from the client). Fetches recent message
// history, asks Groq for a reply, and inserts it via the service-role
// key so it works regardless of who/what triggered this call.
import { supabaseServer } from "./_lib/supabaseServer.js";
import { callGroqChat } from "./_lib/groqClient.js";

const SYSTEM_PROMPT = `You are a friendly, concise customer-support assistant for a small retail store using ABOS.
Reply in the same language/style the customer used (Roman Urdu/Hindi mix, English, or a mix — mirror them).
Keep replies short (1-4 sentences), warm, and helpful. You do not have live access to inventory or order
status in this conversation — if asked something you can't verify, say a team member will confirm shortly
rather than guessing. Never invent prices, stock levels, or order details.`;

const BOT_NAME = "ABOS Assistant";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
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
      // AI is off for this conversation — no-op, not an error.
      res.status(200).json({ skipped: true, reason: "ai_mode is off" });
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

    // Find (or lazily create) the bot's profile row to satisfy the
    // messages table's sender_id foreign key.
    let { data: botProfile } = await supabase
      .from("abos_chat_profiles")
      .select("id")
      .eq("name", BOT_NAME)
      .eq("role", "owner")
      .maybeSingle();

    if (!botProfile) {
      res.status(500).json({
        error:
          "No bot profile found. Run the ai-reply migration's INSERT for the bot profile (see supabase/migration_ai_replies.sql) before enabling AI mode.",
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
