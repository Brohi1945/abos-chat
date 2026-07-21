// GET /api/customer-orders?conversationId=...
// Header: Authorization: Bearer <owner's supabase access token>
//
// There's no formal link between abos-chat customers and ABOS orders —
// ABOS's orders table has no customer_id, just free-text name/phone/
// email captured at checkout. This is a best-effort match on email
// (the one field both systems reliably have), not a guarantee: a
// customer who checked out as a guest with a different email won't
// show up here. Runs server-side with the service-role key so it
// works regardless of the (separately owned) ABOS orders/products RLS
// policies — see the security note flagged separately about those.
import { supabaseServer } from "./_lib/supabaseServer.js";
import { verifyOwner } from "./_lib/verifyOwner.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await verifyOwner(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.message });
    return;
  }

  const { conversationId } = req.query;
  if (!conversationId) {
    res.status(400).json({ error: "conversationId is required" });
    return;
  }

  try {
    const supabase = supabaseServer();

    const { data: convo } = await supabase
      .from("abos_chat_conversations")
      .select("customer_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (!convo) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const { data: profile } = await supabase
      .from("abos_chat_profiles")
      .select("email")
      .eq("id", convo.customer_id)
      .maybeSingle();

    if (!profile?.email) {
      res.status(200).json({ orders: [], note: "Customer has no email on file to match against" });
      return;
    }

    const { data: orders, error } = await supabase
      .from("orders")
      .select("id, customer, items, total, status, date, channel, payment_status")
      .ilike("email", profile.email)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json({ orders: orders || [] });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Internal error" });
  }
}
