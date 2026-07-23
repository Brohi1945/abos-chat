import React, { useEffect, useState } from "react";
import { LogOut, Copy, Check } from "lucide-react";
import { Profile } from "../lib/types";
import { getOrCreateMyConversation, signOut } from "../lib/chatApi";
import ChatWindow from "../components/ChatWindow";
import CallManager from "../components/CallManager";

interface CustomerChatScreenProps {
  me: Profile;
  onSignedOut: () => void;
}

export default function CustomerChatScreen({ me, onSignedOut }: CustomerChatScreenProps) {
  const [conversation, setConversation] = useState<Awaited<ReturnType<typeof getOrCreateMyConversation>>>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      const convo = await getOrCreateMyConversation(me.id);
      setConversation(convo);
    })();
  }, [me.id]);

  const handleCopyNumber = () => {
    navigator.clipboard.writeText(me.customer_number);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleSignOut = async () => {
    await signOut();
    onSignedOut();
  };

  return (
    <CallManager me={me} myConversationId={conversation?.id ?? null}>
      <div className="h-screen flex flex-col bg-slate-950">
        <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between shrink-0">
          <button
            onClick={handleCopyNumber}
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 bg-slate-900 border border-slate-800 rounded-full px-3 py-1.5"
            title="Copy your unique ABOS number"
          >
            {me.customer_number}
            {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} className="text-slate-500" />}
          </button>
          <button onClick={handleSignOut} className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-900">
            <LogOut size={15} />
          </button>
        </div>

        <div className="flex-1 min-h-0">
          {conversation ? (
            <ChatWindow
              conversationId={conversation.id}
              me={me}
              headerTitle="Store"
              headerSubtitle="Usually replies within a few hours"
            />
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-slate-500">Loading chat…</div>
          )}
        </div>
      </div>
    </CallManager>
  );
}
