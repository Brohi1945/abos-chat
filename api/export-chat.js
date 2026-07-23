// ============================================================
//  GET /api/export-chat?conversationId=xxx&format=json
//  Exports chat transcript as JSON, Text, or PDF
//  PHASE 7: Chat Export
// ============================================================

import { supabaseServer } from './_lib/supabaseServer.js';
import { verifyStaff } from './_lib/verifyOwner.js';

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await verifyStaff(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.message });
  }

  const { conversationId, format = 'json' } = req.query;

  if (!conversationId) {
    return res.status(400).json({ error: "conversationId is required" });
  }

  try {
    const supabase = supabaseServer();

    // Check if user has access to this conversation
    const { data: convoCheck, error: convoError } = await supabase
      .from('abos_chat_conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle();

    if (convoError || !convoCheck) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    // Get conversation summary
    const { data: summary, error: summaryError } = await supabase
      .rpc('abos_chat_get_conversation_summary', { p_conversation_id: conversationId });

    if (summaryError) {
      console.error('Summary error:', summaryError);
    }

    // Get transcript
    const { data: messages, error: messagesError } = await supabase
      .rpc('abos_chat_get_transcript', { p_conversation_id: conversationId });

    if (messagesError) {
      console.error('Messages error:', messagesError);
      return res.status(500).json({ error: messagesError.message });
    }

    const exportData = {
      exportedAt: new Date().toISOString(),
      exportedBy: auth.userId,
      conversation: summary?.[0] || null,
      messages: messages || [],
      totalMessages: messages?.length || 0,
    };

    // Send response based on format
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="chat-export-${conversationId}.json"`);
      return res.status(200).json(exportData);
    }

    if (format === 'text') {
      let text = `Chat Transcript\n`;
      text += `================\n\n`;
      text += `Exported: ${new Date().toISOString()}\n`;
      text += `Conversation: ${summary?.[0]?.customer_name || 'Customer'}\n`;
      text += `Total Messages: ${messages?.length || 0}\n\n`;
      text += `---\n\n`;

      for (const msg of messages || []) {
        const sender = msg.sender_name || 'Unknown';
        const time = new Date(msg.created_at).toLocaleString();
        const content = msg.body || `[${msg.kind}]`;
        text += `[${time}] ${sender}: ${content}\n`;
        if (msg.media_url) {
          text += `  (Media: ${msg.media_url})\n`;
        }
        text += '\n';
      }

      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="chat-export-${conversationId}.txt"`);
      return res.status(200).send(text);
    }

    if (format === 'pdf') {
      // For PDF, we need to generate HTML then convert to PDF
      // For now, return JSON with a note
      return res.status(200).json({
        error: 'PDF export coming soon. Use format=json or format=text.',
        data: exportData,
      });
    }

    return res.status(400).json({ error: `Unsupported format: ${format}` });
  } catch (err) {
    console.error('Export error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message,
    });
  }
}
