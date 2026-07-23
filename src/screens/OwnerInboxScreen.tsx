import React, { useEffect, useMemo, useState } from "react";
import { LogOut, MessageCircle, Bot, Megaphone } from "lucide-react";
import { Profile, OwnerInboxRow, ConversationStatus } from "../lib/types";
import { getOwnerInbox, signOut, toggleAiMode } from "../lib/chatApi";
import ChatWindow from "../components/ChatWindow";
import OrderContextPanel from "../components/OrderContextPanel";
import CallManager from "../components/CallManager";
import ThemeSwitcher from "../components/ThemeSwitcher";
import BroadcastComposer from "../components/BroadcastComposer";
import AdminAssistant from "../components/AdminAssistant";

interface OwnerInboxScreenProps {
  me: Profile;
  onSignedOut: () => void;
}

const STATUS_FILTERS: { value: "all" | ConversationStatus; label: string }[] = [
  { value: "all", label: "Sab" },
  { value: "open", label: "Open" },
  { value: "pending", label: "Pending" },
  { value: "urgent", label: "Urgent" },
  { value: "resolved", label: "Resolved" },
];

export default function OwnerInboxScreen({ me, onSignedOut }: OwnerInboxScreenProps) {
  const [conversations, setConversations] = useState<OwnerInboxRow[]>([]);
  const [selected, setSelected] = useState<OwnerInboxRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [mobileShowList, setMobileShowList] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"all" | ConversationStatus>("all");

  // Floating admin AI assistant ("ABI") — mounted once here so it
  // survives conversation switches (voice input/output keeps running
  // instead of getting torn down). Starts as a small bubble; the admin
  // taps it to open the full panel.
  const [assistantMode, setAssistantMode] = useState<"full" | "minimized">("minimized");

  // Broadcast composer — opened manually via the Megaphone button, or
  // handed a pre-filled draft by the AI assistant (still requires a
  // manual tap on "Bhejo" to actually send, never sent automatically).
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [broadcastDraft, setBroadcastDraft] = useState<{ body?: string; tag?: string }>({});

  const load = async () => {
    setLoading(true);
    const data = await getOwnerInbox();
    setConversations(data);
    // keep `selected` in sync with fresh data (e.g. updated unread_count)
    setSelected((prev) => (prev ? data.find((c) => c.id === prev.id) ?? prev : prev));
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

  const handleSelect = (c: OwnerInboxRow) => {
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

  const handleOpenBroadcastDraft = (text: string, tag?: string) => {
    setBroadcastDraft({ body: text, tag });
    setShowBroadcast(true);
  };

  const filteredConversations = useMemo(
    () => (statusFilter === "all" ? conversations : conversations.filter((c) => c.status === statusFilter)),
    [conversations, statusFilter]
  );

  const knownTags = useMemo(() => {
    const set = new Set<string>();
    conversations.forEach((c) => (c.tags || []).forEach((t) => set.add(t)));
    return Array.from(set);
  }, [conversations]);

  const totalUnread = conversations.reduce((sum, c) => sum + c.unread_count, 0);

  return (
    <CallManager me={me} myConversationId={null}>
    <div className="h-screen flex bg-app text-fg">
      {/* Sidebar */}
      <div
        className={`border-r flex flex-col shrink-0 bg-app
          ${mobileShowList ? "flex w-full md:w-72" : "hidden md:flex md:w-72"}`}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div>
            <div className="font-bold text-sm flex items-center gap-1.5 text-fg">
              Inbox
              {totalUnread > 0 && (
                <span className="min-w-[16px] h-4 px-1 rounded-full bg-brand text-white text-[10px] font-bold flex items-center justify-center">
                  {totalUnread > 99 ? "99+" : totalUnread}
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted">{me.email}</div>
          </div>
          <div className="flex items-center gap-1.5">
            <ThemeSwitcher compact />
            <button
              onClick={() => setShowBroadcast(true)}
              title="Broadcast message bhejo"
              className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:bg-fg/5"
            >
              <Megaphone size={15} />
            </button>
            <button
              onClick={handleSignOut}
              className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:bg-fg/5"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1.5 px-3 py-2 border-b overflow-x-auto">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={`shrink-0 text-[11px] font-semibold px-2.5 py-1 rounded-full transition ${
                statusFilter === f.value ? "bg-brand text-white" : "text-muted hover:bg-fg/5"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-8 text-center text-xs text-muted">Loading…</div>
          ) : filteredConversations.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted">
              {conversations.length === 0 ? "Abhi koi customer conversation nahi hai." : "Is filter mein koi conversation nahi mili."}
            </div>
          ) : (
            filteredConversations.map((c) => (
              <button
                key={c.id}
                onClick={() => handleSelect(c)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left border-b ${
                  selected?.id === c.id ? "bg-fg/5" : "hover:bg-fg/5"
                }`}
              >
                <div className="w-9 h-9 rounded-full bg-brand/20 text-brand flex items-center justify-center shrink-0">
                  <MessageCircle size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold truncate flex items-center gap-1.5 text-fg">
                    {c.customer_name || c.customer_email || "Customer"}
                    {c.ai_mode && <Bot size={11} className="text-brand shrink-0" />}
                  </div>
                  <div className="text-[10px] text-muted truncate">{c.customer_number}</div>
                </div>
                {c.unread_count > 0 && (
                  <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-brand text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                    {c.unread_count > 99 ? "99+" : c.unread_count}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className={`flex-1 min-w-0 flex flex-col bg-app ${mobileShowList ? "hidden md:flex" : "flex"}`}>
        {selected ? (
          <>
            <div className="px-4 py-2 border-b flex items-center justify-between bg-surface/50">
              <div className="flex items-center gap-1.5 text-xs text-muted min-w-0">
                <Bot size={13} className="shrink-0" />
                <span className="truncate">AI auto-reply for this customer</span>
              </div>
              <button
                onClick={handleToggleAi}
                className={`relative w-9 h-5 rounded-full transition shrink-0 ml-3 ${
                  selected.ai_mode ? "bg-brand" : "bg-fg/20"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    selected.ai_mode ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>

            <OrderContextPanel conversationId={selected.id} />

            <div className="flex-1 min-h-0">
              <ChatWindow
                conversationId={selected.id}
                me={me}
                headerTitle={selected.customer_name || selected.customer_email || "Customer"}
                headerSubtitle={selected.customer_number}
                onBack={handleBack}
                showBackButton={!mobileShowList}
              />
            </div>
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-muted">
            Ek conversation select karo.
          </div>
        )}
      </div>
    </div>

    <AdminAssistant
      me={me}
      conversations={conversations}
      selected={selected}
      onSelectConversation={handleSelect}
      onStatusFilterChange={setStatusFilter}
      onDataChanged={load}
      onOpenBroadcastDraft={handleOpenBroadcastDraft}
      mode={assistantMode}
      onMinimize={() => setAssistantMode("minimized")}
      onExpand={() => setAssistantMode("full")}
    />

    {showBroadcast && (
      <BroadcastComposer
        me={me}
        knownTags={knownTags}
        initialBody={broadcastDraft.body}
        initialTag={broadcastDraft.tag}
        onClose={() => {
          setShowBroadcast(false);
          setBroadcastDraft({});
        }}
        onSent={() => {
          setShowBroadcast(false);
          setBroadcastDraft({});
          load();
        }}
      />
    )}
    </CallManager>
  );
}
