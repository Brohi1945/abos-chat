import React, { useEffect, useMemo, useState } from "react";
import { LogOut, MessageCircle, Bot, Search, Megaphone, X } from "lucide-react";
import { Profile, OwnerInboxRow, ConversationStatus } from "../lib/types";
import { getOwnerInbox, searchConversations, signOut, toggleAiMode, updateConversationTags } from "../lib/chatApi";
import ChatWindow from "../components/ChatWindow";
import OrderContextPanel from "../components/OrderContextPanel";
import BroadcastComposer from "../components/BroadcastComposer";

interface OwnerInboxScreenProps {
  me: Profile;
  onSignedOut: () => void;
}

const STATUS_TABS: { value: "all" | ConversationStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "pending", label: "Pending" },
  { value: "urgent", label: "Urgent" },
  { value: "resolved", label: "Resolved" },
];

const STATUS_DOT: Record<ConversationStatus, string> = {
  open: "bg-sky-400",
  pending: "bg-amber-400",
  urgent: "bg-red-400",
  resolved: "bg-emerald-400",
};

export default function OwnerInboxScreen({ me, onSignedOut }: OwnerInboxScreenProps) {
  const [conversations, setConversations] = useState<OwnerInboxRow[]>([]);
  const [selected, setSelected] = useState<OwnerInboxRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [mobileShowList, setMobileShowList] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"all" | ConversationStatus>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [showBroadcast, setShowBroadcast] = useState(false);

  const load = async () => {
    setLoading(true);
    const data = await getOwnerInbox();
    setConversations(data);
    setSelected((prev) => (prev ? data.find((c) => c.id === prev.id) ?? prev : prev));
    setLoading(false);
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  // Debounced server-side search — falls back to the normal polling
  // inbox list as soon as the search box is cleared.
  useEffect(() => {
    const term = searchTerm.trim();
    if (!term) return;
    setSearching(true);
    const handle = setTimeout(async () => {
      const results = await searchConversations(term);
      setConversations(results);
      setSearching(false);
    }, 400);
    return () => clearTimeout(handle);
  }, [searchTerm]);

  const handleSignOut = async () => {
    await signOut();
    onSignedOut();
  };

  const handleSelect = (c: OwnerInboxRow) => {
    setSelected(c);
    setTagDraft((c.tags || []).join(", "));
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

  const handleSaveTags = async () => {
    if (!selected) return;
    const tags = tagDraft
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    setSelected({ ...selected, tags });
    setConversations((cs) => cs.map((c) => (c.id === selected.id ? { ...c, tags } : c)));
    await updateConversationTags(selected.id, tags);
  };

  const knownTags = useMemo(() => {
    const set = new Set<string>();
    conversations.forEach((c) => (c.tags || []).forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [conversations]);

  const visibleConversations = useMemo(
    () => (statusFilter === "all" ? conversations : conversations.filter((c) => c.status === statusFilter)),
    [conversations, statusFilter]
  );

  const totalUnread = conversations.reduce((sum, c) => sum + c.unread_count, 0);
  const roleLabel = me.role === "agent" ? "Agent" : "Owner";

  return (
    <div className="h-screen flex bg-slate-950">
      {showBroadcast && (
        <BroadcastComposer
          me={me}
          knownTags={knownTags}
          onClose={() => setShowBroadcast(false)}
          onSent={() => {
            setShowBroadcast(false);
            load();
          }}
        />
      )}

      {/* Sidebar */}
      <div
        className={`border-r border-slate-800 flex flex-col shrink-0 bg-slate-950
          ${mobileShowList ? "flex w-full md:w-80" : "hidden md:flex md:w-80"}`}
      >
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <div className="font-bold text-sm flex items-center gap-1.5">
              Inbox
              {totalUnread > 0 && (
                <span className="min-w-[16px] h-4 px-1 rounded-full bg-brand text-white text-[10px] font-bold flex items-center justify-center">
                  {totalUnread > 99 ? "99+" : totalUnread}
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-500">
              {roleLabel} · {me.email}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowBroadcast(true)}
              className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-900"
              title="Send broadcast"
            >
              <Megaphone size={15} />
            </button>
            <button
              onClick={handleSignOut}
              className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-900"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 pt-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Naam, number, tag ya message search karo…"
              className="w-full pl-8 pr-8 py-2 rounded-lg bg-slate-900 border border-slate-800 text-xs focus:outline-none focus:ring-2 focus:ring-brand/50"
            />
            {searchTerm && (
              <button
                onClick={() => {
                  setSearchTerm("");
                  load();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        {/* Status filter tabs */}
        <div className="flex gap-1.5 px-3 py-2.5 overflow-x-auto">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setStatusFilter(tab.value)}
              className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap ${
                statusFilter === tab.value ? "bg-brand text-white" : "bg-slate-900 text-slate-400 hover:bg-slate-800"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading || searching ? (
            <div className="px-4 py-8 text-center text-xs text-slate-500">Loading…</div>
          ) : visibleConversations.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-slate-500">
              Koi conversation nahi mili.
            </div>
          ) : (
            visibleConversations.map((c) => (
              <button
                key={c.id}
                onClick={() => handleSelect(c)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left border-b border-slate-900 ${
                  selected?.id === c.id ? "bg-slate-900" : "hover:bg-slate-900/50"
                }`}
              >
                <div className="relative w-9 h-9 rounded-full bg-brand/20 text-brand flex items-center justify-center shrink-0">
                  <MessageCircle size={15} />
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-950 ${STATUS_DOT[c.status]}`}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold truncate flex items-center gap-1.5">
                    {c.customer_name || c.customer_email || "Customer"}
                    {c.ai_mode && <Bot size={11} className="text-brand shrink-0" />}
                  </div>
                  <div className="text-[10px] text-slate-500 truncate">{c.customer_number}</div>
                  {c.tags && c.tags.length > 0 && (
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {c.tags.slice(0, 3).map((t) => (
                        <span key={t} className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-400">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
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
      <div className={`flex-1 min-w-0 flex flex-col ${mobileShowList ? "hidden md:flex" : "flex"}`}>
        {selected ? (
          <>
            <div className="px-4 py-2 border-b border-slate-800 flex items-center justify-between gap-3 bg-slate-900/50">
              <div className="flex items-center gap-1.5 text-xs text-slate-400 min-w-0 shrink-0">
                <Bot size={13} className="shrink-0" />
                <span className="truncate">AI auto-reply</span>
              </div>
              <button
                onClick={handleToggleAi}
                className={`relative w-9 h-5 rounded-full transition shrink-0 ${
                  selected.ai_mode ? "bg-brand" : "bg-slate-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    selected.ai_mode ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>

              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onBlur={handleSaveTags}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                placeholder="Tags (comma se separate)…"
                className="flex-1 min-w-0 px-2.5 py-1 rounded-full bg-slate-800 border border-slate-700 text-[11px] focus:outline-none focus:ring-2 focus:ring-brand/50"
              />
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
          <div className="h-full flex items-center justify-center text-xs text-slate-500">
            Ek conversation select karo.
          </div>
        )}
      </div>
    </div>
  );
}
