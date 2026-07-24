// POST /api/admin-chat
// Body: { systemPrompt: string, messages: {role:"user"|"assistant", content:string}[], conversationId?: string }
// Header: Authorization: Bearer <supabase access token>
//
// Backs the floating admin AI assistant (ABI) on the Owner Inbox screen.
// Owner/agent-only (verified via the caller's own Supabase session —
// see verifyStaff). Distinct from /api/groq-reply, which is the
// customer-facing sales/support bot triggered by a DB webhook.
//
// ---- What changed vs. the original version ----
// This endpoint now runs a short server-side tool-calling loop (same
// shape as groq-reply.js) using the SERVICE-ROLE client, so ABI can
// pull live, accurate product stock/price and the selected customer's
// real order history instead of guessing or being limited to whatever
// the browser already had loaded into React state. These tools
// (adminAgentTools.js) are READ-ONLY — nothing here writes to the DB.
//
// Every WRITE action (send_message, start_call, toggle_ai_mode,
// set_status, set_tags, select_conversation, filter_status,
// prepare_broadcast, send_location) is still decided by the model but
// *executed in the browser* afterwards, using the admin's own
// RLS-scoped session — exactly as before. That split is intentional:
// it's what keeps this endpoint unable to do anything the signed-in
// admin couldn't already do by hand, per ABI_README.md §4.2/§5. Only
// read accuracy was added here, not new write power.
import { verifyStaff } from "./_lib/verifyOwner.js";
import { callGroqAgent } from "./_lib/groqClient.js";
import { supabaseServer } from "./_lib/supabaseServer.js";
import { ADMIN_READ_TOOLS, executeAdminReadTool } from "./_lib/adminAgentTools.js";

export const config = {
  maxDuration: 20,
};

const MAX_TOOL_ITERATIONS = 4;
// Kept safely under maxDuration above so there's always time left to
// return whatever text we've got instead of the function getting killed
// mid-loop.
const OVERALL_TIME_BUDGET_MS = 16000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await verifyStaff(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.message });
  }

  const startedAt = Date.now();

  try {
    const { systemPrompt, messages, conversationId } = req.body || {};
    if (!systemPrompt || !Array.isArray(messages)) {
      return res.status(400).json({ error: "systemPrompt and messages are required" });
    }

    const supabase = supabaseServer();
    const apiMessages = [{ role: "system", content: systemPrompt }, ...messages];

    let finalText = "";
    let ranOutOfTime = false;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (Date.now() - startedAt > OVERALL_TIME_BUDGET_MS) {
        ranOutOfTime = true;
        break;
      }

      const assistantMsg = await callGroqAgent(apiMessages, ADMIN_READ_TOOLS);
      if (!assistantMsg) break;

      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        finalText = (assistantMsg.content || "").trim();
        break;
      }

      apiMessages.push({ role: "assistant", content: assistantMsg.content || null, tool_calls: assistantMsg.tool_calls });

      for (const call of assistantMsg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await executeAdminReadTool(
          supabase,
          { selectedConversationId: conversationId || null },
          call.function.name,
          args
        );
        apiMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    if (ranOutOfTime && !finalText) {
      finalText = JSON.stringify({
        reply: "Ek second lagega, dobara try karein — thodi der mein jawab de dunga.",
        action: null,
      });
    }

    if (!finalText) {
      finalText = JSON.stringify({
        reply: "Mujhe iska koi acha jawab nahi mil raha — dobara try karein?",
        action: null,
      });
    }

    return res.status(200).json({ content: [{ type: "text", text: finalText }] });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.data || err.message });
  }
}
