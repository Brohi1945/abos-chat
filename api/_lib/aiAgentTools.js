// Tools the AI agent can call during a reply — this is what turns it
// from "just answers questions" into "actually takes the order."
// Each tool reads/writes the real DB via the service-role client, so
// results are always grounded in live stock/prices, never invented.

function genOrderId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `ORD-${s}`;
}

async function getDraft(supabase, conversationId) {
  const { data } = await supabase
    .from("abos_chat_ai_drafts")
    .select("items")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return (data?.items || []);
}

async function saveDraft(supabase, conversationId, items) {
  await supabase
    .from("abos_chat_ai_drafts")
    .upsert({ conversation_id: conversationId, items, updated_at: new Date().toISOString() });
}

function draftTotal(items) {
  return items.reduce((sum, it) => sum + it.price * it.quantity, 0);
}

async function findProduct(supabase, name) {
  const { data } = await supabase
    .from("products")
    .select("id, name, price, stock, reserved_stock, category")
    .ilike("name", `%${name.trim()}%`)
    .order("name")
    .limit(1)
    .maybeSingle();
  return data || null;
}

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "add_to_order",
      description:
        "Add one or more products to the customer's in-progress order (their cart for this conversation). Use this as soon as the customer says what they want to buy, even one item at a time.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                product_name: { type: "string", description: "Product name as it appears in the catalog" },
                quantity: { type: "integer", minimum: 1 },
              },
              required: ["product_name", "quantity"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_from_order",
      description: "Remove a product from the customer's in-progress order.",
      parameters: {
        type: "object",
        properties: { product_name: { type: "string" } },
        required: ["product_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_order",
      description: "See the current in-progress order (items + running total) before confirming.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_order",
      description:
        "Finalize the in-progress order and actually place it. Only call this after the customer has clearly agreed to the items AND you have their phone number and delivery address. Never call this on a guess.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "Customer's phone number for delivery" },
          address: { type: "string", description: "Delivery address" },
          note: { type: "string", description: "Any special instructions the customer gave" },
        },
        required: ["phone", "address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Hand this conversation off to a human team member instead of handling it yourself — use for complaints, refund/return requests, anything you're not confident about, or if the customer explicitly asks for a human.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
];

/** Runs one tool call and returns a JSON-serializable result to feed
 *  back to the model. `onOrderConfirmed` is called with the finished
 *  order so groq-reply.js can drop a rich order-card message. */
export async function executeTool(supabase, ctx, name, args, onOrderConfirmed) {
  const { conversationId, customer } = ctx;

  if (name === "add_to_order") {
    const draft = await getDraft(supabase, conversationId);
    const notFound = [];
    const warnings = [];

    for (const req of args.items || []) {
      const product = await findProduct(supabase, req.product_name);
      if (!product) {
        notFound.push(req.product_name);
        continue;
      }
      const available = product.stock - (product.reserved_stock || 0);
      if (available <= 0) {
        warnings.push(`${product.name} is currently out of stock.`);
        continue;
      }
      const qty = Math.min(req.quantity, available);
      if (qty < req.quantity) {
        warnings.push(`Only ${available} of ${product.name} available — added ${qty}.`);
      }
      const existing = draft.find((i) => i.product_id === product.id);
      if (existing) existing.quantity += qty;
      else draft.push({ product_id: product.id, name: product.name, price: Number(product.price), quantity: qty });
    }

    await saveDraft(supabase, conversationId, draft);
    return { draft, subtotal: draftTotal(draft), not_found: notFound, warnings };
  }

  if (name === "remove_from_order") {
    const draft = await getDraft(supabase, conversationId);
    const next = draft.filter((i) => !i.name.toLowerCase().includes((args.product_name || "").toLowerCase()));
    await saveDraft(supabase, conversationId, next);
    return { draft: next, subtotal: draftTotal(next) };
  }

  if (name === "view_order") {
    const draft = await getDraft(supabase, conversationId);
    return { draft, subtotal: draftTotal(draft) };
  }

  if (name === "confirm_order") {
    const draft = await getDraft(supabase, conversationId);
    if (draft.length === 0) {
      return { error: "The order is empty — nothing has been added yet." };
    }

    // Re-check stock right before placing the order, in case it
    // changed since items were added.
    const unavailable = [];
    for (const item of draft) {
      const { data: fresh } = await supabase
        .from("products")
        .select("stock, reserved_stock")
        .eq("id", item.product_id)
        .maybeSingle();
      const available = (fresh?.stock || 0) - (fresh?.reserved_stock || 0);
      if (available < item.quantity) unavailable.push(item.name);
    }
    if (unavailable.length > 0) {
      return { error: `No longer enough stock for: ${unavailable.join(", ")}. Ask the customer how to proceed.` };
    }

    const orderId = genOrderId();
    const total = draftTotal(draft);
    const { error: insertErr } = await supabase.from("orders").insert({
      id: orderId,
      customer: customer.name || customer.customer_number,
      items: draft.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
      total,
      status: "pending",
      date: new Date().toISOString(),
      channel: "AI Assistant (Chat)",
      email: customer.email,
      phone: args.phone,
      address: args.address,
      payment_status: "unpaid",
    });
    if (insertErr) return { error: `Could not place the order: ${insertErr.message}` };

    await saveDraft(supabase, conversationId, []);
    await supabase.from("abos_chat_conversations").update({ status: "pending" }).eq("id", conversationId);

    const orderSnapshot = { order_id: orderId, items: draft, total, status: "pending" };
    if (onOrderConfirmed) onOrderConfirmed(orderSnapshot);
    return { ok: true, order_id: orderId, total };
  }

  if (name === "escalate_to_human") {
    const { data: convo } = await supabase
      .from("abos_chat_conversations")
      .select("tags")
      .eq("id", conversationId)
      .maybeSingle();
    const tags = Array.from(new Set([...(convo?.tags || []), "ai-escalated"]));
    await supabase.from("abos_chat_conversations").update({ status: "urgent", tags }).eq("id", conversationId);
    return { ok: true };
  }

  return { error: `Unknown tool: ${name}` };
}
