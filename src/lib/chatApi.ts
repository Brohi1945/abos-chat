// ============================================================
//  src/lib/chatApi.ts
//  Complete Chat API — Phase 1 to 7
//  - Messages, conversations, broadcasts
//  - Message queue (Phase 5)
//  - Read receipts (Phase 5)
// ============================================================

import { supabase } from "./supabaseClient";
import {
  Profile,
  Conversation,
  ChatMessage,
  MessageKind,
  OwnerInboxRow,
  ProductSnapshot,
  LinkedOrder,
  ConversationStatus,
} from "./types";

// ============================================================
//  Auth
// ============================================================

export async function signUp(email: string, password: string, name: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
  return { data, error };
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return { data, error };
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getCurrentProfile(): Promise<Profile | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await supabase
      .from("abos_chat_profiles")
      .select("*")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (data) return data as Profile;
    if (error) console.error(error);
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// =========================================================
