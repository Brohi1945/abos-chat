// ============================================================
//  POST /api/send-push
//  Sends Web Push notifications for incoming calls/messages
//  PHASE 4a: Web Push Notifications
// ============================================================

import webpush from 'web-push';
import { supabaseServer } from './_lib/supabaseServer.js';

export const config = {
  maxDuration: 10,
};

// VAPID keys — set these in Vercel env vars
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@abos.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // ---- Auth ----
    // This endpoint had no auth check at all — any unauthenticated request
    // on the internet could POST an arbitrary userId and force a push to
    // them, or burn through the webpush send quota. Require a valid
    // Supabase session. (Once this feature is actually wired up to a
    // specific flow — e.g. "notify the other side of this conversation" —
    // this can be tightened further to check the caller is a real
    // participant in that conversation, the same way verifyCallerForConversation
    // does for /api/groq-reply.)
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }

    const supabase = supabaseServer();

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const { userId, title, body, icon, data, conversationId } = req.body;

    if (!userId || !title || !body) {
      return res.status(400).json({ error: "Missing userId, title, or body" });
    }

    // Get user's push subscriptions
    const { data: subscriptions, error } = await supabase
      .from('abos_chat_push_subscriptions')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      console.error('Error fetching subscriptions:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!subscriptions || subscriptions.length === 0) {
      return res.status(200).json({ message: 'No subscriptions found for user' });
    }

    const payload = JSON.stringify({
      title,
      body,
      icon: icon || '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      data: {
        url: data?.url || '/',
        conversationId,
        callId: data?.callId,
        type: data?.type || 'notification',
      },
      vibrate: [200, 100, 200],
    });

    const results = [];

    for (const sub of subscriptions) {
      try {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            auth: sub.auth,
            p256dh: sub.p256dh,
          },
        };

        await webpush.sendNotification(pushSubscription, payload);
        results.push({ endpoint: sub.endpoint, success: true });
      } catch (err) {
        console.error('Push send failed:', err);
        // If subscription is invalid, remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase
            .from('abos_chat_push_subscriptions')
            .delete()
            .eq('endpoint', sub.endpoint);
          results.push({ endpoint: sub.endpoint, success: false, removed: true });
        } else {
          results.push({ endpoint: sub.endpoint, success: false, error: err.message });
        }
      }
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error('Push notification error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message,
    });
  }
}
