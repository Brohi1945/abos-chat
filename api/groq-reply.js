// POST /api/groq-reply
// Body: { conversationId: string }
// Header: x-abos-chat-webhook-secret: <shared secret>
//
// Called by a Postgres trigger (see supabase/migration_ai_reply_webhook.sql)
// via pg_net whenever a customer sends a text message on a conversation
// with ai_mode = true. Never called directly by the browser.
import { supabaseServer } from "./_lib/supabaseServer.js";
import { callGroqChat } from "./_lib/groqClient.js";

const BOT_NAME = "ABOS Assistant";
const MIN_SECONDS_BETWEEN_AI_REPLIES = 20;
const MAX_PRODUCTS_IN_CONTEXT = 20;

function buildSystemPrompt(products) {
  const inventoryBlock =
    products.length === 0
      ? "No product catalog data is currently available."
      : products
          .map((p) => {
            const stockNote = p.stock > 0 ? `${p.stock} in stock` : "out of stock";
            return `- ${p.name} (${p.category || "uncategorized"}): Rs ${p.price}, ${stockNote}`;
          })
          .join("\n");

  return `You are a friendly, concise customer-support assistant for a small retail store using ABOS.
Reply in the same language/style the customer used (Roman Urdu/Hindi mix, English, or a mix — mirror them).
Keep replies short (1-4 sentences), warm, and helpful.

Here is the store's CURRENT product catalog (name, category, price in PKR, live stock level).
Use this to answer questions about price, availability, and stock accurately:
${inventoryBlock}

Rules:
- Only state a price or stock number if it appears in the catalog above. Never invent one.
- If a product the customer asks about isn't in the list above, say you're not sure and a team member will confirm — don't guess.
- You have no visibility into a specific customer's past orders or delivery status in this conversation — for those, say a team member will check and confirm shortly.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
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
      res.status(200).json({ skipped: true, reason: "ai_mode is off" });
      return;
    }

    const since = new Date(Date.now() - MIN_SECONDS_BETWEEN_AI_REPLIES * 1000).toISOString();

    const [{ data: recentAiReply }, { data: recentMessages }, { data: products }] = await Promise.all([
      supabase
        .from("abos_chat_messages")
        .select("id")
        .eq("conversation_id", conversationId)
        .eq("is_ai", true)
        .gte("created_at", since)
        .limit(1)
        .maybeSingle(),
      supabase
        .from("abos_chat_messages")
        .select("sender_role, kind, body, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(12),
      supabase.from("products").select("name, category, price, stock").order("name").limit(MAX_PRODUCTS_IN_CONTEXT),
    ]);

    if (recentAiReply) {
      res.status(200).json({ skipped: true, reason: "rate limited" });
      return;
    }

    const history = (recentMessages || [])
      .reverse()
      .filter((m) => m.kind === "text" && m.body)
      .map((m) => ({ role: m.sender_role === "customer" ? "user" : "assistant", content: m.body }));

    if (history.length === 0) {
      res.status(200).json({ skipped: true, reason: "no text messages to reply to" });
      return;
    }

    // Ground the AI in real, current inventory instead of letting it
    // guess prices/stock. Small catalogs: pull everything. Larger ones
    // could instead filter by keyword match against the latest
    // customer message — flagged as a follow-up if the catalog grows
    // past a size where sending it all every time gets expensive.
    const systemPrompt = buildSystemPrompt(products || []);

    const reply = await callGroqChat(systemPrompt, history);
    if (!reply) {
      res.status(200).json({ skipped: true, reason: "empty reply from model" });
      return;
    }

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
