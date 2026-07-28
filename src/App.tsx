// ============================================================
//  src/App.tsx
//  Complete App — Phase 1 to 7
//  - Auth gate
//  - Routes to Customer or Owner screen
// ============================================================

import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Toaster } from "react-hot-toast";
import { supabase } from "./lib/supabaseClient";
import { getCurrentProfile } from "./lib/chatApi";
import { Profile } from "./lib/types";
import { ThemeProvider } from "./theme";
import { setSentryUser } from "./lib/sentry";
import AuthScreen from "./screens/AuthScreen";
import CustomerChatScreen from "./screens/CustomerChatScreen";
import OwnerInboxScreen from "./screens/OwnerInboxScreen";

const OWNER_EMAILS = (import.meta.env.VITE_OWNER_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// Anyone who should land on the inbox (owner OR agent), and is active.
// This was the Phase 9 routing gap: agents exist as a role in the DB and
// in RLS (abos_chat_is_owner already treats owner+agent as staff), but
// this check used to only look at 'owner' — an agent would silently land
// on the customer chat screen instead. Fixed here.
function isStaff(profile: Profile): boolean {
  if (profile.active === false) return false;
  if (profile.role === "owner" || profile.role === "agent") return true;
  return !!profile.email && OWNER_EMAILS.includes(profile.email.toLowerCase());
}

// Strictly the real owner — used only to gate owner-only admin UI
// (e.g. the Staff management screen), never for inbox routing.
function isOwner(profile: Profile): boolean {
  if (profile.role === "owner") return true;
  return !!profile.email && OWNER_EMAILS.includes(profile.email.toLowerCase());
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);

  const refresh = async () => {
    setLoading(true);
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      const p = await getCurrentProfile();
      setProfile(p);
      if (p) setSentryUser(p.id, p.role);
    } else {
      setProfile(null);
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const { data: sub } = supabase.auth.onAuthStateChange(() => refresh());
    return () => sub.subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <ThemeProvider>
        <Toaster position="top-center" />
        <div className="h-screen flex items-center justify-center bg-app">
          <Loader2 className="animate-spin text-muted" size={22} />
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <Toaster position="top-center" />
      {!profile ? (
        <AuthScreen onAuthed={refresh} />
      ) : isStaff(profile) ? (
        <OwnerInboxScreen me={profile} onSignedOut={refresh} isOwner={isOwner(profile)} />
      ) : (
        <CustomerChatScreen me={profile} onSignedOut={refresh} />
      )}
    </ThemeProvider>
  );
}
