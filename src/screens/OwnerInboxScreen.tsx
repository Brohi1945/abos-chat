import React, { useEffect, useMemo, useRef, useState } from "react";
import { LogOut, MessageCircle, Bot, Megaphone, Users, MoreVertical } from "lucide-react";
import { Profile, OwnerInboxRow, ConversationStatus } from "../lib/types";
import { getOwnerInbox, signOut, toggleAiMode, setAwayStatus, subscribeToStaffAlerts } from "../lib/chatApi";
import { toastError } from "../lib/toast";
import ChatWindow from "../components/ChatWindow";
import OrderContextPanel from "../components/OrderContextPanel";
import CallManager from "../components/CallManager";
import ThemeSwitcher from "../components/ThemeSwitcher";
import BroadcastComposer from "../components/BroadcastComposer";
import AdminAssistant from "../components/AdminAssistant";
import StaffScreen from "./StaffScreen";

interface OwnerInboxScreenProps {
  me: Profile;
  onSignedOut: () => void;
  // True only for the real owner (role === 'owner'), never for an agent —
  // gates the Staff-management entry point. See App.tsx isOwner/isStaff.
  isOwner: boolean;
}

const STATUS_FILTERS: { value: "all" | ConversationStatus; label: string }[] = [
  { value: "all", label: "Sab" },
  { value: "open", label: "Open" },
  { value: "pending", label: "Pending" },
  { value: "urgent", label: "Urgent" },
  { value: "resolved", label: "Resolved" },
];

// Phase 9 Feature 3: assignment filter — client-side over the
// already-fetched inbox rows, no new RPC needed for this.
type AssignFilter = "all" | "unassigned" | "mine";
const ASSIGN_FILTERS: { value: AssignFilter; label: string }[] = [
  { value: "all", label: "Sab" },
  { value: "unassigned", label: "Unassigned" },
  { value: "mine", label: "Mujhe assigned" },
];

export default function OwnerInboxScreen({ me, onSignedOut, isOwner }: OwnerInboxScreenProps) {
  const [conversations, setConversations] = useState<OwnerInboxRow[]>([]);
  const [selected, setSelected] = useState<OwnerInboxRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [mobileShowList, setMobileShowList] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"all" | ConversationStatus>("all");
  const [assignFilter, setAssignFilter] = useState<AssignFilter>("all");
  const [showStaff, setShowStaff] = useState(false);

  // Phase 9 Feature 2: away toggle — owned locally (optimistic update,
  // reverted on failure), since `me` here is a snapshot from App.tsx
  // and doesn't re-fetch on every render.
  const [isAway, setIsAway] = useState(me.is_away);

  const handleToggleAway = async () => {
    const next = !isAway;
    setIsAway(next);
    const ok = await setAwayStatus(me.id, next);
    if (!ok) {
      setIsAway(!next);
      toastError("Away status update nahi ho saka — dobara try karo.");
    }
  };

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

  // PHASE 4.4: Sentiment Detection → Real Auto-Escalate Alert — the AI
  // already tags a conversation "urgent" via escalate_to_human; this
  // surfaces it immediately as a toast instead of waiting for the next
  // 15s poll to quietly reveal it in the list.
  useEffect(() => {
    const unsubscribe = subscribeToStaffAlerts((alert) => {
      toastError(`${alert.customer_name} — ${alert.reason}`);
      load();
    });
    return unsubscribe;
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

  const filteredConversations = useMemo(() => {
    let list = statusFilter === "all" ? conversations : conversations.filter((c) => c.status === statusFilter);
    if (assignFilter === "unassigned") list = list.filter((c) => !c.assigned_to);
    else if (assignFilter === "mine") list = list.filter((c) => c.assigned_to === me.id);
    return list;
  }, [conversations, statusFilter, assignFilter, me.id]);

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
        <div className="px-4 py-3 border-b flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-bold text-sm flex items-center gap-1.5 text-fg">
              Inbox
              {totalUnread > 0 && (
                <span className="min-w-[16px] h-4 px-1 rounded-full bg-brand text-white text-[10px] font-bold flex items-center justify-center">
                  {totalUnread > 99 ? "99+" : totalUnread}
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted line-clamp-1 [overflow-wrap:anywhere]">{me.email}</div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <AwayToggle isAway={isAway} onToggle={handleToggleAway} />
            <ThemeSwitcher compact />
            <HeaderMoreMenu
              isOwner={isOwner}
              onStaff={() => setShowStaff(true)}
              onBroadcast={() => setShowBroadcast(true)}
            />
            <button
              onClick={handleSignOut}
              title="Sign out"
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

        {/* Phase 9 Feature 3: assignment filter — separate row so it
            never competes with the status chips for width on mobile */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b overflow-x-auto">
          {ASSIGN_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setAssignFilter(f.value)}
              className={`shrink-0 text-[11px] font-semibold px-2.5 py-1 rounded-full transition ${
                assignFilter === f.value ? "bg-brand/15 text-brand" : "text-muted hover:bg-fg/5"
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
                  <div className="text-xs font-semibold flex items-center gap-1.5 text-fg">
                    <span className="min-w-0 line-clamp-1 [overflow-wrap:anywhere]">
                      {c.customer_name || c.customer_email || "Customer"}
                    </span>
                    {c.ai_mode && <Bot size={11} className="text-brand shrink-0" />}
                  </div>
                  <div className="text-[10px] text-muted line-clamp-1 [overflow-wrap:anywhere]">{c.customer_number}</div>
                  {c.assigned_name && (
                    <div className="text-[10px] text-brand flex items-center gap-1 mt-0.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          c.assigned_is_away ? "bg-warning" : "bg-success"
                        }`}
                      />
                      <span className="min-w-0 line-clamp-1 [overflow-wrap:anywhere]">{c.assigned_name}</span>
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
                reserveBottomSpace
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
    {showStaff && <StaffScreen me={me} onClose={() => setShowStaff(false)} />}
    </CallManager>
  );
}

// ============================================================
//  AwayToggle — Phase 9 Feature 2. Purely informational (doesn't
//  block replies or reassign anything) — just marks the signed-in
//  staff member's own availability. Label hides on very narrow
//  screens (same squeeze-avoidance approach as HeaderMoreMenu
//  above) so only the compact dot+pill remains.
// ============================================================
function AwayToggle({ isAway, onToggle }: { isAway: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={isAway ? "Away hai — tap karke available mark karo" : "Available hai — tap karke away mark karo"}
      className={`flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full shrink-0 transition ${
        isAway ? "bg-warning/15 text-warning" : "bg-success/15 text-success"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isAway ? "bg-warning" : "bg-success"}`} />
      <span className="hidden sm:inline">{isAway ? "Away" : "Available"}</span>
    </button>
  );
}

// ============================================================
//  HeaderMoreMenu — one button, opens Staff + Broadcast.
//  Consolidated here (instead of two separate always-visible icons)
//  because on narrow screens every extra header icon was squeezing
//  the email/title text into an overflow/wrap. Theme and Sign-out
//  stay as their own visible buttons per the requested layout —
//  only these two admin actions move behind this menu.
// ============================================================
function HeaderMoreMenu({
  isOwner,
  onStaff,
  onBroadcast,
}: {
  isOwner: boolean;
  onStaff: () => void;
  onBroadcast: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Aur options"
        aria-label="Aur options"
        aria-expanded={open}
        className={`w-8 h-8 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 ${
          open ? "bg-fg/10" : ""
        }`}
      >
        <MoreVertical size={15} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 bg-surface border rounded-xl shadow-lg py-1 min-w-[170px]">
          {isOwner && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onStaff();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-fg hover:bg-fg/5"
            >
              <Users size={14} className="shrink-0 text-muted" />
              Staff manage karo
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onBroadcast();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-fg hover:bg-fg/5"
          >
            <Megaphone size={14} className="shrink-0 text-muted" />
            Broadcast bhejo
          </button>
        </div>
      )}
    </div>
  );
}
