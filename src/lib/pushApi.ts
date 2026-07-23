// ============================================================
//  src/lib/pushApi.ts
//  Web Push API — Phase 4a
//  Subscribe/Unsubscribe to push notifications
// ============================================================

import { supabase } from "./supabaseClient";

export interface PushSubscription {
  endpoint: string;
  auth: string;
  p256dh: string;
}

// Check if Push is supported
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// Request notification permission
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) {
    return "denied";
  }

  if (Notification.permission === "granted") {
    return "granted";
  }

  if (Notification.permission === "denied") {
    return "denied";
  }

  return await Notification.requestPermission();
}

// Subscribe to push notifications
export async function subscribeToPush(
  userId: string
): Promise<PushSubscription | null> {
  if (!isPushSupported()) {
    console.warn("Push not supported in this browser");
    return null;
  }

  try {
    const permission = await requestNotificationPermission();
    if (permission !== "granted") {
      console.warn("Notification permission not granted");
      return null;
    }

    // Get service worker registration
    const registration = await navigator.serviceWorker.ready;

    // Subscribe to push
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: import.meta.env.VITE_VAPID_PUBLIC_KEY,
    });

    const subscriptionJSON = subscription.toJSON();

    if (!subscriptionJSON.endpoint || !subscriptionJSON.keys) {
      console.warn("Invalid subscription");
      return null;
    }

    const pushSub: PushSubscription = {
      endpoint: subscriptionJSON.endpoint,
      auth: subscriptionJSON.keys.auth || "",
      p256dh: subscriptionJSON.keys.p256dh || "",
    };

    // Save to Supabase
    const { error } = await supabase.from("abos_chat_push_subscriptions").upsert(
      {
        user_id: userId,
        endpoint: pushSub.endpoint,
        auth: pushSub.auth,
        p256dh: pushSub.p256dh,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "endpoint" }
    );

    if (error) {
      console.error("Error saving push subscription:", error);
      return null;
    }

    return pushSub;
  } catch (err) {
    console.error("Push subscription error:", err);
    return null;
  }
}

// Unsubscribe from push notifications
export async function unsubscribeFromPush(userId: string): Promise<boolean> {
  if (!isPushSupported()) {
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      await subscription.unsubscribe();
    }

    // Remove from Supabase
    if (subscription?.endpoint) {
      await supabase
        .from("abos_chat_push_subscriptions")
        .delete()
        .eq("endpoint", subscription.endpoint);
    }

    return true;
  } catch (err) {
    console.error("Push unsubscription error:", err);
    return false;
  }
}

// Send push notification via server
export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<boolean> {
  try {
    const token = await supabase.auth.getSession().then((s) => s.data.session?.access_token);
    if (!token) {
      console.warn("Not authenticated");
      return false;
    }

    const response = await fetch("/api/send-push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        userId,
        title,
        body,
        data,
      }),
    });

    if (!response.ok) {
      console.error("Push send failed:", response.status);
      return false;
    }

    return true;
  } catch (err) {
    console.error("Push send error:", err);
    return false;
  }
}
