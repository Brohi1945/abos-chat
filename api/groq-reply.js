// POST /api/groq-reply
// Body: { conversationId: string }
// Header: x-abos-chat-webhook-secret: <shared secret>
//
// Called by a Postgres trigger (see supabase/migration_ai_reply_webhook.sql)
// via pg_net whenever a customer sends a text message on a conversation
// with ai_mode = true. Never called directly by the browser.
//
// The AI now acts as a real sales/support agent: it can add items to
// an order, confirm it (which places a real row in `orders`), or hand
// the conversation off to a human — not just answer questions.
import { supabaseServer } from "./_lib/supabaseServer.js";
import { callGroqAgent } from "./_lib/groqClient.js";
import { TOOLS, executeTool } from "./_lib/aiAgentTools.js";

const BOT_NAME = "ABOS Assistant";
const MIN_SECONDS_BETWEEN_AI_REPLIES = 20;
const MAX_PRODUCTS_IN_CONTEXT = 20;
const MAX_TOOL_ITERATIONS = 4;

function buildSystemPrompt(products, draftItems) {
  const inventoryBlock =
    products.length === 0
      ? "No product catalog data is currently available."
      : products
          .map((p) => {
            const available = p.stock - (p.reserved_stock || 0);
            const stockNote = available > 0 ? `${available} in stock` : "out of stock";
            return `- ${p.name} (${p.category || "uncategorized"}): Rs ${p.price}, ${stockNote}`;
          })
          .join("\n");

  const draftBlock =
    draftItems.length > 0
      ? `The customer already has an order in progress:\n${draftItems
          .map((i) => `- ${i.quantity}x ${i.name} @ Rs ${i.price}`)
          .join("\n")}`
      : "No order in progress yet.";

  return `You are "${BOT_NAME}", the store's sales and customer-support agent on ABOS. You are not a passive FAQ bot — act like a capable human sales rep: be proactive, decisive, and actually get things done for the customer.
Reply in the same language/style the customer used (Roman Urdu/Hindi mix, English, or a mix — mirror them). Keep replies short (1-4 sentences), warm, and confident.

Here is the store's CURRENT product catalog (name, category, price in PKR, live stock):
${inventoryBlock}

${draftBlock}

How to behave:
- If the customer asks about a product, answer directly from the catalog above. Never invent a price or stock number.
- If the customer wants to buy something, use add_to_order right away — don't just say "sure I'll note that down," actually call the tool.
- Before calling confirm_order, make sure you have the customer's phone number and delivery address — ask for whichever is missing. Read back the order (items + total) and get a clear "yes/confirm" before finalizing.
- After confirm_order succeeds, tell the customer their order number and that the store will follow up on delivery.
- If a requested product isn't in the catalog, or the customer wants a refund/return, is upset, or asks for something outside what you can do, call escalate_to_human and tell the customer a team member will follow up shortly — don't guess.
- Never claim to know a customer's past order/delivery status unless it was told to you in this conversation.`;
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
      .select("id, ai_mode, customer_id")
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

    const [{ data: recentAiReply }, { data: recentMessages }, { data: products }, { data: draftRow }, { data: customer }] =
      await Promise.all([
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
        supabase.from("products").select("name, category, price, stock, reserved_stock").order("name").limit(MAX_PRODUCTS_IN_CONTEXT),
        supabase.from("abos_chat_ai_drafts").select("items").eq("conversation_id", conversationId).maybeSingle(),
        supabase.from("abos_chat_profiles").select("id, name, email, customer_number").eq("id", conversation.customer_id).maybeSingle(),
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

    const draftItems = draftRow?.items || [];
    const systemPrompt = buildSystemPrompt(products || [], draftItems);
    const messages = [{ role: "system", content: systemPrompt }, ...history];

    let confirmedOrder = null;
    let finalText = "";

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const assistantMsg = await callGroqAgent(messages, TOOLS);
      if (!assistantMsg) break;

      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        finalText = (assistantMsg.content || "").trim();
        break;
      }

      messages.push({ role: "assistant", content: assistantMsg.content || null, tool_calls: assistantMsg.tool_calls });

      for (const call of assistantMsg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await executeTool(
          supabase,
          { conversationId, customer: customer || {} },
          call.function.name,
          args,
          (order) => {
            confirmedOrder = order;
          }
        );
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    if (!finalText && !confirmedOrder) {
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

    if (finalText) {
      const { error: insertErr } = await supabase.from("abos_chat_messages").insert({
        conversation_id: conversationId,
        sender_id: botProfile.id,
        sender_role: "owner",
        kind: "text",
        body: finalText,
        is_ai: true,
      });
      if (insertErr) {
        res.status(500).json({ error: insertErr.message });
        return;
      }
    }

    if (confirmedOrder) {
      await supabase.from("abos_chat_messages").insert({
        conversation_id: conversationId,
        sender_id: botProfile.id,
        sender_role: "owner",
        kind: "order",
        order_snapshot: confirmedOrder,
        is_ai: true,
      });
    }

    await supabase
      .from("abos_chat_conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conversationId);

    res.status(200).json({ ok: true, reply: finalText, order: confirmedOrder });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Internal error" });
  }
}
