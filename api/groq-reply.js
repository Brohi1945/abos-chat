// POST /api/groq-reply
// Body: { conversationId: string, messageId?: string }
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

// Vercel: this handler can genuinely need 10-20s (Groq + up to 4 tool
// round-trips). Without this, Vercel's default duration limit can kill
// the function mid-reply, which used to look like "no reply at all."
export const config = {
  maxDuration: 30,
};

const BOT_NAME = "ABOS Assistant";
const MAX_PRODUCTS_IN_CONTEXT = 20;
const MAX_TOOL_ITERATIONS = 4;

// How long we wait before actually calling Groq, to let a burst of
// quick customer messages ("Hi" / "I want" / "5kg rice") settle down
// into one reply instead of several. If a newer customer message shows
// up during this wait, THIS invocation backs off — the newer message's
// own trigger call will handle everything (it always pulls the last 12
// messages, so nothing is lost, it just gets answered once, by the
// invocation that's actually looking at the final message).
const DEBOUNCE_MS = 2500;

// Hard wall-clock budget for the whole tool-calling loop, kept safely
// under maxDuration above so we always have time left to insert
// whatever reply we've got instead of getting killed mid-flight.
const OVERALL_TIME_BUDGET_MS = 24000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Belt-and-suspenders: the system prompt tells the model not to use
// markdown, but strip stray ** / __ markers anyway so a slip-up never
// shows up as literal asterisks in the customer's chat.
function stripStrayMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\s*\n{3,}/g, "\n\n")
    .trim();
}

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

  return `You are "${BOT_NAME}" — a 25+ year veteran sales professional running this store's chat, plus its customer-support rep. You've closed thousands of sales and you know how to read a customer, build value, and get to "yes" — but you're also the person who sorts out problems when something's wrong. You are not a passive FAQ bot.

Here is the store's CURRENT product catalog (name, category, price in PKR, live stock):
${inventoryBlock}

${draftBlock}

Language rule (follow this exactly):
- Look ONLY at the customer's most recent message and pick ONE style: if it's Roman Urdu, reply fully in Roman Urdu; if it's English, reply fully in English. Never mix both in the same reply, and never write the same sentence twice in two languages.

Formatting rule:
- Plain chat text only. Never use markdown — no **, no _, no bullet dashes, no headings. If you want to emphasize something just say it plainly.

Message rule:
- Send ONE clean, final message only. Never include meta-commentary, stage directions, or placeholders like "(waiting for user response)" or "..." — those are not for the customer to see. Never restate the same information more than once in a single reply.
- Never invent or state a specific store/brand name (you don't reliably know it). Refer to it generically as "the store" / "hum" / "hamari dukaan" — never make one up.

How to sell (be assertive, not passive):
- Don't just answer and wait — always move the conversation toward a decision. After answering a question, follow up with a clear next step ("Add kar dun?" / "Shall I add this for you?").
- Lead with the benefit, not just the spec — why this product is a good pick, not just its price.
- Cross-sell from the real catalog only: if a customer orders one thing, suggest one genuinely relevant item that pairs with it (e.g. cooking oil with rice) — one suggestion, not a pushy list.
- Use real stock levels to create honest urgency ("sirf 4 pieces bache hain" — only if that's the true number from the catalog above). Never invent scarcity, fake countdowns, or fake demand ("10 log abhi dekh rahe hain") — that's lying to the customer and it's not allowed.
- When the customer hesitates, address the real concern (price, need, trust) confidently and offer to proceed — don't just drop it, but don't badger someone who's said no twice.
- Use add_to_order the moment they show buying intent, and drive toward confirm_order — don't let a ready customer stall. Before calling confirm_order, get their phone number and delivery address (ask for whichever is missing), read back the items + total, and get a clear "yes/confirm" — never finalize on a guess.

How to support:
- If the customer has a question, problem, or complaint, switch fully into support mode: listen, don't push a sale in the same breath as solving a real problem.
- If a requested product isn't in the catalog, or the customer wants a refund/return, is upset, or asks for something outside what you can do, call escalate_to_human and tell the customer a team member will follow up shortly — don't guess, and don't try to sell your way out of a complaint.
- Never claim to know a customer's past order/delivery status unless it was told to you in this conversation.
- Never invent a price or stock number — always pull from the catalog above.

After confirm_order succeeds, tell the customer their order number and that the store will follow up on delivery — don't name the store, just say "the store" / "hum".`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const startedAt = Date.now();

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

    const { conversationId, messageId } = req.body || {};
    if (!conversationId) {
      res.status(400).json({ error: "conversationId is required" });
      return;
    }

    const supabase = supabaseServer();

    // --- Debounce instead of the old "skip if we replied recently" rate
    // limit. That old check silently dropped the customer's message
    // forever if it landed within 20s of our last reply. This instead
    // waits a moment, then only proceeds if nothing newer has arrived.
    if (messageId) {
      await sleep(DEBOUNCE_MS);
      const { data: latestCustomerMsg } = await supabase
        .from("abos_chat_messages")
        .select("id")
        .eq("conversation_id", conversationId)
        .eq("sender_role", "customer")
        .eq("kind", "text")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestCustomerMsg && latestCustomerMsg.id !== messageId) {
        res.status(200).json({ skipped: true, reason: "superseded by a newer customer message" });
        return;
      }
    }

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

    const [{ data: recentMessages }, { data: products }, { data: draftRow }, { data: customer }] = await Promise.all([
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
    let ranOutOfTime = false;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (Date.now() - startedAt > OVERALL_TIME_BUDGET_MS) {
        ranOutOfTime = true;
        break;
      }

      const assistantMsg = await callGroqAgent(messages, TOOLS);
      if (!assistantMsg) break;

      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        finalText = stripStrayMarkdown(assistantMsg.content || "");
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

    // If we ran out of time mid-loop and never got a text reply, don't
    // leave the customer with total silence — send a short holding
    // message and flag the conversation for a human to check.
    if (ranOutOfTime && !finalText && !confirmedOrder) {
      finalText = "Ek second lagega — main abhi check kar ke aap ko batata hoon. Team member bhi jald follow up karega.";
      try {
        const { data: convo } = await supabase
          .from("abos_chat_conversations")
          .select("tags")
          .eq("id", conversationId)
          .maybeSingle();
        const tags = Array.from(new Set([...(convo?.tags || []), "ai-timeout"]));
        await supabase.from("abos_chat_conversations").update({ status: "pending", tags }).eq("id", conversationId);
      } catch {
        // best-effort tagging only, don't block the reply on this
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
