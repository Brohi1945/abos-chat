// Server-side Supabase client — uses the SERVICE ROLE key so it can
// insert AI-generated messages on the store's behalf, bypassing RLS.
// NEVER import this file into frontend (src/) code — service role key
// must only ever run on the server (Vercel function), never ship to
// the browser.
import { createClient } from "@supabase/supabase-js";

export function supabaseServer() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables");
  }
  return createClient(url, serviceKey);
}

// PHASE 4.4: Sentiment Detection → Real Auto-Escalate Alert
// Sends a one-shot Realtime Broadcast message via Supabase's REST
// broadcast endpoint — deliberately NOT opening a websocket channel
// (subscribe/send/unsubscribe) from inside a short-lived serverless
// function, which would add real latency for no benefit here. The
// service-role key bypasses RLS, so this can publish to any topic;
// only staff can actually *receive* on "staff-alerts" per the Realtime
// Authorization policy on realtime.messages.
export async function broadcastServerMessage(topic, event, payload) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables");
  }
  const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
    },
    body: JSON.stringify({ messages: [{ topic, event, payload, private: true }] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Realtime broadcast failed: ${res.status} ${text}`);
  }
}
