import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Toaster } from "react-hot-toast";
import { supabase } from "./lib/supabaseClient";
import { getCurrentProfile } from "./lib/chatApi";
import { Profile } from "./lib/types";
import { ThemeProvider } from "./theme";
import AuthScreen from "./screens/AuthScreen";
import CustomerChatScreen from "./screens/CustomerChatScreen";
import OwnerInboxScreen from "./screens/OwnerInboxScreen";

// Comma-separated list of emails that should see the Owner Inbox even
// before abos_chat_profiles.role has been flipped to 'owner' in the DB.
// UI convenience only — actual data access is still gated server-side
// by Postgres RLS, which only trusts abos_chat_profiles.role = 'owner'.
const OWNER_EMAILS = (import.meta.env.VITE_OWNER_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

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
      ) : isOwner(profile) ? (
        <OwnerInboxScreen me={profile} onSignedOut={refresh} />
      ) : (
        <CustomerChatScreen me={profile} onSignedOut={refresh} />
      )}
    </ThemeProvider>
  );
}
