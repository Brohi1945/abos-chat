// POST /api/admin-chat
// Body: { systemPrompt: string, messages: {role:"user"|"assistant", content:string}[] }
// Header: Authorization: Bearer <supabase access token>
//
// Backs the floating admin AI assistant on the Owner Inbox screen.
// Owner/agent-only (verified via the caller's own Supabase session —
// see verifyStaff). Distinct from /api/groq-reply, which is the
// customer-facing sales/support bot triggered by a DB webhook and
// runs with the service-role key; this endpoint speaks for the ADMIN,
// answering questions about / acting on the inbox the admin is
// currently looking at. It never touches the DB directly — the
// browser executes whatever action the model proposes using the
// same RLS-protected client calls the admin's own UI already uses,
// so this endpoint can't do anything the signed-in admin couldn't
// already do by hand.
import { verifyStaff } from "./_lib/verifyOwner.js";
import { callGroqAgent } from "./_lib/groqClient.js";

export const config = {
  maxDuration: 20,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await verifyStaff(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.message });
  }

  try {
    const { systemPrompt, messages } = req.body || {};
    if (!systemPrompt || !Array.isArray(messages)) {
      return res.status(400).json({ error: "systemPrompt and messages are required" });
    }

    const apiMessages = [{ role: "system", content: systemPrompt }, ...messages];
    const reply = await callGroqAgent(apiMessages, null);
    const text = (reply?.content || "").trim();
    return res.status(200).json({ content: [{ type: "text", text }] });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.data || err.message });
  }
}
