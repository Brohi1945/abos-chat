import React, { useEffect, useState } from "react";
import { LogOut, MessageCircle, Bot, ArrowLeft } from "lucide-react";
import { Profile, Conversation } from "../lib/types";
import { listAllConversations, signOut, toggleAiMode } from "../lib/chatApi";
import ChatWindow from "../components/ChatWindow";

interface OwnerInboxScreenProps {
  me: Profile;
  onSignedOut: () => void;
}

export default function OwnerInboxScreen({ me, onSignedOut }: OwnerInboxScreenProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [mobileShowList, setMobileShowList] = useState(true);

  const load = async () => {
    setLoading(true);
    const data = await listAllConversations();
    setConversations(data);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleSignOut = async () => {
    await signOut();
    onSignedOut();
  };

  const handleSelect = (c: Conversation) => {
    setSelected(c);
    setMobileShowList(false);
  };

  const handleBack = () => {
    setMobileShowList(true);
    setSelected(null);
  };

  const handleToggleAi = async () => {
    if (!selected) return;
    const next = !selected.ai_mode;
    setSelected({ ...selected, ai_mode: next });
    setConversations((cs) => cs.map((c) => (c.id === selected.id ? { ...c, ai_mode: next } : c)));
    await toggleAiMode(selected.id, next);
  };

  return (
    <div className="h-screen flex bg-slate-950">
      {/* Sidebar — full width on mobile when list shown, hidden on mobile when chat open */}
      <div
        className={`border-r border-slate-800 flex flex-col shrink-0 bg-slate-950
          ${mobileShowList ? "flex w-full md:w-72" : "hidden md:flex md:w-72"}`}
      >
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <div className="font-bold text-sm">Inbox</div>
            <div className="text-[11px] text-slate-500">{me.email}</div>
          </div>
          <button
            onClick={handleSignOut}
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-900"
          >
            <LogOut size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-8 text-center text-xs text-slate-500">Loading…</div>
          ) : conversations.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-slate-500">
              Abhi koi customer conversation nahi hai.
            </div>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => handleSelect(c)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left border-b border-slate-900 ${
                  selected?.id === c.id ? "bg-slate-900" : "hover:bg-slate-900/50"
                }`}
              >
                <div className="w-9 h-9 rounded-full bg-brand/20 text-brand flex items-center justify-center shrink-0">
                  <MessageCircle size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold truncate flex items-center gap-1.5">
                    {c.customer?.name || c.customer?.email || "Customer"}
                    {c.ai_mode && <Bot size={11} className="text-brand shrink-0" />}
                  </div>
                  <div className="text-[10px] text-slate-500 truncate">
                    {c.customer?.customer_number}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Chat area — hidden on mobile when list shown */}
      <div
        className={`flex-1 min-w-0 flex flex-col ${
          mobileShowList ? "hidden md:flex" : "flex"
        }`}
      >
        {selected ? (
          <>
            {/* AI toggle bar */}
            <div className="px-4 py-2 border-b border-slate-800 flex items-center justify-between bg-slate-900/50">
              <div className="flex items-center gap-1.5 text-xs text-slate-400 min-w-0">
                <Bot size={13} className="shrink-0" />
                <span className="truncate">AI auto-reply for this customer</span>
              </div>
              <button
                onClick={handleToggleAi}
                className={`relative w-9 h-5 rounded-full transition shrink-0 ml-3 ${
                  selected.ai_mode ? "bg-brand" : "bg-slate-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    selected.ai_mode ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>

            <div className="flex-1 min-h-0">
              <ChatWindow
                conversationId={selected.id}
                me={me}
                headerTitle={selected.customer?.name || selected.customer?.email || "Customer"}
                headerSubtitle={selected.customer?.customer_number}
                onBack={handleBack}
                showBackButton={!mobileShowList}
              />
            </div>
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-slate-500">
            Ek conversation select karo.
          </div>
        )}
      </div>
    </div>
  );
}
