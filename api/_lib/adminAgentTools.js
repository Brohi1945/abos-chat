// api/_lib/adminAgentTools.js
//
// Read-only tools for ABI (the admin assistant). Unlike aiAgentTools.js
// (which the CUSTOMER-facing bot uses to write orders), everything here
// only ever SELECTs — it exists purely so ABI's answers about stock,
// price, and a customer's orders are pulled live from the real DB via
// the service-role client (bypasses RLS, always accurate) instead of
// being guessed by the model or limited to whatever the browser already
// happened to have loaded into React state.
//
// Anything that CHANGES data (sending a message, placing a call,
// changing status/tags, toggling ai_mode) intentionally stays out of
// this file and out of the server entirely — those actions are still
// decided by the model but *executed in the browser* using the admin's
// own RLS-scoped session (see AdminAssistant.tsx's runAction). That's
// not an oversight: it's what makes ABI's writes provably "nothing the
// signed-in admin couldn't already do by hand," per ABI_README.md §4.2.
// This file only ever adds READ capability, never write.

export const ADMIN_READ_TOOLS = [
  {
    type: "function",
    function: {
      name: "lookup_products",
      description:
        "Search the store's live product catalog for real-time price and stock. Always call this instead of guessing when the admin asks about a product's price, stock level, or category. Omit `query` to get a general snapshot of the catalog (most recently named products, up to 20).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product name or partial name to search for. Omit for a general catalog snapshot." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_customer_orders",
      description:
        "Get the currently SELECTED customer's real order history (order id, items, total, status, date), matched by the email on file for their chat profile. Always call this instead of guessing when the admin asks about a customer's orders, delivery status, or order total. Only works if a conversation is currently selected — if none is selected, this returns an error explaining that.",
      parameters: { type: "object", properties: {} },
    },
  },
];

export async function executeAdminReadTool(supabase, ctx, name, args) {
  const { selectedConversationId } = ctx;

  if (name === "lookup_products") {
    let q = supabase
      .from("products")
      .select("name, category, price, stock, reserved_stock")
      .order("name")
      .limit(20);

    if (args?.query && String(args.query).trim()) {
      q = q.ilike("name", `%${String(args.query).trim()}%`);
    }

    const { data, error } = await q;
    if (error) return { error: error.message };
    const products = (data || []).map((p) => ({
      name: p.name,
      category: p.category,
      price: p.price,
      // Report AVAILABLE stock (stock minus whatever's already reserved
      // in an in-progress order elsewhere), not raw stock — raw stock
      // can overstate what's actually sellable right now.
      available: p.stock - (p.reserved_stock || 0),
    }));
    if (products.length === 0) return { products: [], note: "No matching products found." };
    return { products };
  }

  if (name === "lookup_customer_orders") {
    if (!selectedConversationId) {
      return { error: "No conversation is currently selected — ask the admin to select one first." };
    }

    const { data: convo, error: convoErr } = await supabase
      .from("abos_chat_conversations")
      .select("customer_id")
      .eq("id", selectedConversationId)
      .maybeSingle();
    if (convoErr || !convo) return { error: "Could not find the selected conversation." };

    const { data: profile } = await supabase
      .from("abos_chat_profiles")
      .select("email, name")
      .eq("id", convo.customer_id)
      .maybeSingle();

    if (!profile?.email) {
      return { orders: [], note: "This customer has no email on file, so their store orders can't be matched (no reliable shared ID between chat and orders)." };
    }

    const { data: orders, error } = await supabase
      .from("orders")
      .select("id, items, total, status, date, channel, payment_status")
      .ilike("email", profile.email)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) return { error: error.message };
    return { customer_name: profile.name, orders: orders || [] };
  }

  return { error: `Unknown tool: ${name}` };
}
