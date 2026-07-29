// ============================================================
//  src/components/ChatWindow.tsx
//  Complete Chat Window — Phase 1 to 8
//  - Messages, typing, read receipts (Phase 5)
//  - Call buttons
//  - Reply/quote, edit, soft-delete, pin, reactions, in-chat
//    search, canned responses (Phase 8 — Quick Wins)
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import {
  Send,
  Image as ImageIcon,
  MapPin,
  Mic,
  Square,
  Loader2,
  ArrowLeft,
  AlertCircle,
  ChevronUp,
  Package,
  Phone,
  Video,
  Search,
  Zap,
  X,
  Pin,
  Pencil,
  Plus,
  MoreVertical,
  UserX,
  StickyNote,
  Trash2,
} from "lucide-react";
import {
  ChatMessage,
  Profile,
  Conversation,
  ProductSnapshot,
  ConversationStatus,
  MessageReaction,
  ConversationNote,
} from "../lib/types";
import DebugErrorBoundary from "./DebugErrorBoundary"; // TEMPORARY — remove once quick-wins bug is found
import {
  listMessages,
  sendMessage,
  sendProductMessage,
  subscribeToMessages,
  uploadMedia,
  getConversation,
  markConversationRead,
  subscribeToConversation,
  subscribeToTyping,
  updateConversationStatus,
  markMessagesRead,
  processMessageQueue,
  // Phase 8
  editMessage,
  deleteMessage,
  pinMessage,
  unpinMessage,
  getPinnedMessages,
  getReactionsForMessages,
  toggleReaction,
  subscribeToReactions,
  subscribeToMessageUpdates,
  searchMessagesInConversation,
  getMessageById,
  // Phase 9 Feature 3 & 4
  assignConversation,
  listAllProfiles,
  listNotes,
  addNote,
  deleteNote,
} from "../lib/chatApi";
import MessageBubble from "./MessageBubble";
import ProductPicker from "./ProductPicker";
import CannedResponsesPicker from "./CannedResponsesPicker";
import { useCall } from "./CallManager";

const STATUS_OPTIONS: { value: ConversationStatus; label: string; className: string }[] = [
  { value: "open", label: "Open", className: "bg-accent/15 text-accent" },
  { value: "pending", label: "Pending", className: "bg-warning/15 text-warning" },
  { value: "urgent", label: "Urgent", className: "bg-danger/15 text-danger" },
  { value: "resolved", label: "Resolved", className: "bg-success/15 text-success" },
];

function staffIdentity(me: Profile) {
  if (me.role === "customer") return {};
  return { senderName: me.name || me.email || undefined, senderTitle: (me.role === "owner" ? "Owner" : "Agent") as "Owner" | "Agent" };
}

// Small kind-aware summary used for the reply-preview bar and the
// pinned-message bar (MessageBubble has its own copy for the in-bubble
// quote preview — kept local here rather than shared to avoid coupling
// ChatWindow to MessageBubble's internals).
function previewText(m: ChatMessage): string {
  if (m.deleted_at) return "Message deleted";
  switch (m.kind) {
    case "text":
      return m.body || "";
    case "image":
      return m.body ? `📷 ${m.body}` : "📷 Photo";
    case "voice":
      return "🎤 Voice note";
    case "recording":
      return "🔴 Call recording";
    case "location":
      return "📍 Location";
    case "product":
      return `📦 ${m.product_snapshot?.name || "Product"}`;
    case "order":
      return `🛍️ Order ${m.order_snapshot?.order_id || ""}`;
    default:
      return m.body || "Message";
  }
}

function upsertReaction(prev: Record<string, MessageReaction[]>, r: MessageReaction) {
  const list = (prev[r.message_id] || []).filter((x) => x.user_id !== r.user_id);
  return { ...prev, [r.message_id]: [...list, r] };
}

function removeReactionFor(prev: Record<string, MessageReaction[]>, messageId: string, userId: string) {
  const list = (prev[messageId] || []).filter((x) => x.user_id !== userId);
  return { ...prev, [messageId]: list };
}

interface ChatWindowProps {
  conversationId: string;
  me: Profile;
  headerTitle: string;
  headerSubtitle?: string;
  onBack?: () => void;
  showBackButton?: boolean;
  // OwnerInboxScreen floats the ABI assistant bubble at bottom:96/right:20,
  // fixed-position, so it paints on top of the message list regardless of
  // this component's own layout. Without extra scroll padding, the last
  // message can render directly underneath it and get visually covered.
  // Set true wherever that floating bubble is mounted alongside this screen.
  reserveBottomSpace?: boolean;
}

function getSupportedMimeType(): string | null {
  const types = [
    "audio/webm",
    "audio/webm;codecs=opus",
    "audio/mp4",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/ogg",
    "audio/ogg;codecs=opus",
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

export default function ChatWindow({
  conversationId,
  me,
  headerTitle,
  headerSubtitle,
  onBack,
  showBackButton,
  reserveBottomSpace,
}: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [otherTyping, setOtherTyping] = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);

  // ---- Phase 8: Quick Wins state ----
  const [reactionsByMessage, setReactionsByMessage] = useState<Record<string, MessageReaction[]>>({});
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [pinnedMessages, setPinnedMessages] = useState<ChatMessage[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<ChatMessage[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showCannedResponses, setShowCannedResponses] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // UI fix: image/voice stay on the always-visible bar; location, product
  // and quick-replies live behind this collapsible attachment drawer so
  // the main bar isn't cramped with tiny icons on mobile.
  const [showAttachMenu, setShowAttachMenu] = useState(false);

  // ---- Phase 9 Feature 3: conversation assignment ----
  const [staffList, setStaffList] = useState<Profile[]>([]);
  const [showAssignMenu, setShowAssignMenu] = useState(false);
  const assignMenuRef = useRef<HTMLDivElement>(null);

  // ---- Phase 9 Feature 4: internal notes (staff-only) ----
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState<ConversationNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  const chatRole: "customer" | "owner" = me.role === "customer" ? "customer" : "owner";
  const { startCall } = useCall();

  const handleStartCall = (kind: "voice" | "video") => {
    startCall(conversationId, kind, headerTitle);
  };

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const lastMessageIdRef = useRef<string | null>(null);
  const typingApiRef = useRef<ReturnType<typeof subscribeToTyping> | null>(null);

  // ---- Phase 5: Process message queue ----
  useEffect(() => {
    // Process queue every 30 seconds
    const queueInterval = setInterval(() => {
      processMessageQueue(me.id);
    }, 30000);

    // Also process on mount
    processMessageQueue(me.id);

    return () => clearInterval(queueInterval);
  }, [me.id]);

  // ---- Phase 9 Feature 3: staff list for the Assign menu ----
  // Never runs for a customer session — nothing here is customer-safe
  // to even fetch (listAllProfiles is gated by RLS too, but there's no
  // reason to make the call at all from a customer screen).
  useEffect(() => {
    if (me.role === "customer") return;
    let cancelled = false;
    listAllProfiles().then((all) => {
      if (cancelled) return;
      setStaffList(all.filter((p) => (p.role === "owner" || p.role === "agent") && p.active));
    });
    return () => {
      cancelled = true;
    };
  }, [me.role]);

  useEffect(() => {
    if (!showAssignMenu) return;
    const onDocClick = (e: MouseEvent) => {
      if (assignMenuRef.current && !assignMenuRef.current.contains(e.target as Node)) setShowAssignMenu(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [showAssignMenu]);

  // ---- Phase 9 Feature 4: load notes each time the panel opens ----
  useEffect(() => {
    if (!showNotes) return;
    let cancelled = false;
    setNotesLoading(true);
    listNotes(conversationId).then((data) => {
      if (cancelled) return;
      setNotes(data);
      setNotesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [showNotes, conversationId]);

  const mergeMessages = (incoming: ChatMessage[]) => {
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return Array.from(byId.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
  };

  // ---- Phase 8: fetch reactions for a batch of message ids ----
  const loadReactionsFor = async (ids: string[]) => {
    if (ids.length === 0) return;
    const data = await getReactionsForMessages(ids);
    setReactionsByMessage((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = data.filter((r) => r.message_id === id);
      return next;
    });
  };

  const loadPinned = async () => {
    const pinned = await getPinnedMessages(conversationId);
    setPinnedMessages(pinned);
  };

  useEffect(() => {
    let unsubMessages = () => {};
    let unsubMessageUpdates = () => {};
    let unsubConversation = () => {};
    let unsubReactions = () => {};
    let pollId: ReturnType<typeof setInterval>;

    (async () => {
      const [page, convo] = await Promise.all([listMessages(conversationId), getConversation(conversationId)]);
      setMessages(page.messages);
      setHasMoreOlder(page.hasMore);
      setConversation(convo);
      loadReactionsFor(page.messages.map((m) => m.id));
      loadPinned();

      // ---- Phase 5: Mark messages as read ----
      await markMessagesRead(conversationId, me.id);
      markConversationRead(conversationId, chatRole);

      unsubMessages = subscribeToMessages(conversationId, (msg) => {
        mergeMessages([msg]);
        // Mark as read when new message arrives
        if (msg.sender_id !== me.id) {
          markMessagesRead(conversationId, me.id);
          markConversationRead(conversationId, chatRole);
        }
      });

      // Phase 8: live edits/deletes/pins from the other side
      unsubMessageUpdates = subscribeToMessageUpdates(conversationId, (msg) => {
        mergeMessages([msg]);
        loadPinned();
      });

      unsubConversation = subscribeToConversation(conversationId, (updated) => setConversation(updated));

      // Phase 8: live reactions (global channel, filtered locally by message ownership)
      unsubReactions = subscribeToReactions(({ eventType, reaction, oldReaction }) => {
        setReactionsByMessage((prev) => {
          if (eventType === "DELETE" && oldReaction) {
            return removeReactionFor(prev, oldReaction.message_id, oldReaction.user_id);
          }
          if (reaction) {
            return upsertReaction(prev, reaction);
          }
          return prev;
        });
      });

      pollId = setInterval(async () => {
        const latest = await listMessages(conversationId);
        mergeMessages(latest.messages);
      }, 4000);
    })();

    typingApiRef.current = subscribeToTyping(conversationId, chatRole, setOtherTyping);

    return () => {
      unsubMessages();
      unsubMessageUpdates();
      unsubConversation();
      unsubReactions();
      clearInterval(pollId);
      typingApiRef.current?.unsubscribe();
      setOtherTyping(false);
    };
  }, [conversationId]);

  useEffect(() => {
    const lastId = messages[messages.length - 1]?.id ?? null;
    if (lastId && lastId !== lastMessageIdRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    lastMessageIdRef.current = lastId;
  }, [messages]);

  const loadOlderMessages = async () => {
    if (loadingOlder || !hasMoreOlder || messages.length === 0) return;
    setLoadingOlder(true);

    const oldest = messages[0].created_at;
    const container = scrollContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    const prevScrollTop = container?.scrollTop ?? 0;

    const page = await listMessages(conversationId, oldest);
    setMessages((prev) => {
      const existingIds = new Set(prev.map((m) => m.id));
      const newOnes = page.messages.filter((m) => !existingIds.has(m.id));
      return [...newOnes, ...prev];
    });
    setHasMoreOlder(page.hasMore);
    loadReactionsFor(page.messages.map((m) => m.id));
    setLoadingOlder(false);

    requestAnimationFrame(() => {
      if (container) {
        const grew = container.scrollHeight - prevScrollHeight;
        container.scrollTop = prevScrollTop + grew;
      }
    });
  };

  const showError = (msg: string) => {
    setErrorMsg(msg);
    setTimeout(() => setErrorMsg(""), 4000);
  };

  const handleTextChange = (value: string) => {
    setText(value);
    typingApiRef.current?.setTyping(value.trim().length > 0);
  };

  const handleSendText = async () => {
    const body = text.trim();
    if (!body) return;

    // Phase 8: editing an existing message instead of sending a new one
    if (editingMessage) {
      const target = editingMessage;
      setText("");
      setEditingMessage(null);
      const ok = await editMessage(target.id, body);
      if (ok) {
        setMessages((prev) =>
          prev.map((m) => (m.id === target.id ? { ...m, body, edited_at: new Date().toISOString() } : m))
        );
      } else {
        showError("Message edit nahi ho saka — dobara try karo.");
      }
      return;
    }

    setText("");
    typingApiRef.current?.setTyping(false);
    const replyToId = replyingTo?.id;
    setReplyingTo(null);
    await sendMessage({
      conversationId,
      senderId: me.id,
      senderRole: chatRole,
      kind: "text",
      body,
      replyToId,
      ...staffIdentity(me),
    });
  };

  const handleStatusChange = async (status: ConversationStatus) => {
    if (!conversation) return;
    setConversation({ ...conversation, status });
    await updateConversationStatus(conversation.id, status);
  };

  // ---- Phase 9 Feature 3: assign / unassign (staffId = null to unassign) ----
  const handleAssign = async (staffId: string | null) => {
    if (!conversation) return;
    setShowAssignMenu(false);
    const prevAssignedTo = conversation.assigned_to;
    setConversation({ ...conversation, assigned_to: staffId });
    const ok = await assignConversation(conversation.id, staffId);
    if (!ok) {
      setConversation((c) => (c ? { ...c, assigned_to: prevAssignedTo } : c));
      showError("Assign nahi ho saka — dobara try karo.");
    }
  };

  // ---- Phase 9 Feature 4: internal notes (staff-only) ----
  const handleAddNote = async () => {
    const body = noteText.trim();
    if (!body || savingNote) return;
    setSavingNote(true);
    const ok = await addNote(conversationId, me.id, body);
    setSavingNote(false);
    if (!ok) {
      showError("Note save nahi hui — dobara try karo.");
      return;
    }
    setNoteText("");
    const fresh = await listNotes(conversationId);
    setNotes(fresh);
  };

  const handleDeleteNote = async (noteId: string) => {
    if (!window.confirm("Yeh internal note delete karna hai?")) return;
    const ok = await deleteNote(noteId);
    if (ok) {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    } else {
      showError("Note delete nahi hui — dobara try karo.");
    }
  };

  const handlePickImage = () => fileInputRef.current?.click();

  const handleImageSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    const ext = file.name.split(".").pop() || "jpg";
    const url = await uploadMedia(file, `conversations/${conversationId}`, ext);
    setBusy(false);
    if (url) {
      await sendMessage({
        conversationId,
        senderId: me.id,
        senderRole: chatRole,
        kind: "image",
        mediaUrl: url,
        ...staffIdentity(me),
      });
    }
  };

  const handleShareLocation = () => {
    if (!navigator.geolocation) {
      showError("Location support is not available on this device/browser.");
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        await sendMessage({
          conversationId,
          senderId: me.id,
          senderRole: chatRole,
          kind: "location",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          ...staffIdentity(me),
        });
        setBusy(false);
      },
      (err) => {
        setBusy(false);
        let msg = "Location access denied or failed.";
        if (err.code === 1) msg = "Location permission denied. Please allow location access in your browser settings.";
        if (err.code === 2) msg = "Location unavailable. Check your GPS/network.";
        if (err.code === 3) msg = "Location request timed out.";
        showError(msg);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const handlePickProduct = async (product: ProductSnapshot) => {
    setShowProductPicker(false);
    await sendProductMessage(conversationId, me, product);
  };

  const handleToggleRecording = async () => {
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }

    if (!navigator.mediaDevices || !window.MediaRecorder) {
      showError("Voice recording is not supported on this browser. Try Chrome or Safari.");
      return;
    }

    const mimeType = getSupportedMimeType();
    if (!mimeType) {
      showError("Voice recording format not supported on this device.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        if (blob.size === 0) {
          showError("Recording failed — no audio captured.");
          return;
        }
        const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
        setBusy(true);
        const url = await uploadMedia(blob, `conversations/${conversationId}`, ext);
        setBusy(false);
        if (url) {
          await sendMessage({
            conversationId,
            senderId: me.id,
            senderRole: chatRole,
            kind: "voice",
            mediaUrl: url,
            ...staffIdentity(me),
          });
        }
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        showError("Recording error occurred. Please try again.");
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err: any) {
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        showError("Microphone permission denied. Please allow mic access in your browser settings.");
      } else if (err.name === "NotFoundError") {
        showError("No microphone found on this device.");
      } else {
        showError("Could not start recording: " + (err.message || "Unknown error"));
      }
    }
  };

  // ---- Phase 8: Reply / Edit / Delete / Pin / React ----

  const handleReplyStart = (msg: ChatMessage) => {
    setEditingMessage(null);
    setReplyingTo(msg);
    setActiveMessageId(null);
    inputRef.current?.focus();
  };

  const handleCancelReply = () => setReplyingTo(null);

  const handleEditStart = (msg: ChatMessage) => {
    setReplyingTo(null);
    setEditingMessage(msg);
    setText(msg.body || "");
    setActiveMessageId(null);
    inputRef.current?.focus();
  };

  const handleCancelEdit = () => {
    setEditingMessage(null);
    setText("");
  };

  const handleDeleteMessage = async (msg: ChatMessage) => {
    setActiveMessageId(null);
    if (!window.confirm("Yeh message delete karna hai? Yeh sabko 'deleted' dikhega.")) return;
    const ok = await deleteMessage(msg.id);
    if (ok) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id ? { ...m, deleted_at: new Date().toISOString(), body: null, media_url: null } : m
        )
      );
    } else {
      showError("Message delete nahi ho saka.");
    }
  };

  const handleTogglePin = async (msg: ChatMessage) => {
    setActiveMessageId(null);
    if (msg.pinned_at) {
      const ok = await unpinMessage(msg.id);
      if (!ok) {
        showError("Unpin nahi ho saka — dobara try karo.");
        return;
      }
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, pinned_at: null, pinned_by: null } : m)));
    } else {
      const ok = await pinMessage(msg.id, me.id);
      if (!ok) {
        showError("Pin nahi ho saka — dobara try karo.");
        return;
      }
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, pinned_at: new Date().toISOString(), pinned_by: me.id } : m))
      );
    }
    loadPinned();
  };

  const handleReact = async (msg: ChatMessage, emoji: string) => {
    const existing = reactionsByMessage[msg.id]?.find((r) => r.user_id === me.id);
    const result = await toggleReaction(msg.id, me.id, emoji, existing);
    if (result === "error") {
      showError("Reaction save nahi hui — dobara try karo (console mein exact error hai).");
      return;
    }
    setReactionsByMessage((prev) => {
      if (result === "removed") return removeReactionFor(prev, msg.id, me.id);
      if (result === "added" || result === "changed") {
        return upsertReaction(prev, {
          id: existing?.id || `local-${msg.id}-${me.id}`,
          message_id: msg.id,
          user_id: me.id,
          emoji,
          created_at: new Date().toISOString(),
        });
      }
      return prev;
    });
  };

  // ---- Phase 8: jump to a message (from reply-quote tap or search result) ----
  const jumpToMessage = async (target: ChatMessage) => {
    setShowSearch(false);
    setSearchTerm("");
    const alreadyLoaded = messages.some((m) => m.id === target.id);
    if (!alreadyLoaded) {
      const cursor = new Date(new Date(target.created_at).getTime() + 1).toISOString();
      const page = await listMessages(conversationId, cursor);
      mergeMessages(page.messages);
      loadReactionsFor(page.messages.map((m) => m.id));
    }
    requestAnimationFrame(() => {
      setTimeout(() => {
        document.getElementById(`msg-${target.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightId(target.id);
        setTimeout(() => setHighlightId(null), 1600);
      }, 50);
    });
  };

  const jumpToMessageId = async (id: string) => {
    const found = messages.find((m) => m.id === id);
    if (found) {
      jumpToMessage(found);
      return;
    }
    const fetched = await getMessageById(id);
    if (fetched) jumpToMessage(fetched);
  };

  // ---- Phase 8: in-chat search (debounced) ----
  useEffect(() => {
    if (!showSearch) return;
    let cancelled = false;
    setSearchLoading(true);
    const t = setTimeout(async () => {
      const results = await searchMessagesInConversation(conversationId, searchTerm);
      if (!cancelled) {
        setSearchResults(results);
        setSearchLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [searchTerm, showSearch, conversationId]);

  const myMessages = messages.filter((m) => m.sender_id === me.id);
  const lastMineId = myMessages.length ? myMessages[myMessages.length - 1].id : null;

  return (
    <div className="relative flex flex-col h-full">
      <DebugErrorBoundary label="Overlays (product/canned-responses/search)">
      {showProductPicker && <ProductPicker onPick={handlePickProduct} onClose={() => setShowProductPicker(false)} />}

      {showCannedResponses && (
        <CannedResponsesPicker
          myUserId={me.id}
          onPick={(body) => {
            setShowCannedResponses(false);
            setText(body);
            inputRef.current?.focus();
          }}
          onClose={() => setShowCannedResponses(false)}
        />
      )}

      {showSearch && (
        <div className="absolute inset-0 z-20 flex flex-col" style={{ backgroundColor: "var(--color-bg)" }}>
          <div className="px-4 py-3 border-b flex items-center gap-2">
            <Search size={15} className="text-muted shrink-0" />
            <input
              autoFocus
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Is conversation mein search karo…"
              className="flex-1 bg-transparent text-sm text-fg focus:outline-none"
            />
            <button
              onClick={() => {
                setShowSearch(false);
                setSearchTerm("");
              }}
              className="text-muted hover:text-fg shrink-0"
            >
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {searchLoading ? (
              <div className="px-4 py-8 text-center text-xs text-muted">Search ho raha hai…</div>
            ) : !searchTerm.trim() ? (
              <div className="px-4 py-8 text-center text-xs text-muted">Message likh kar search karo.</div>
            ) : searchResults.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted">Koi message nahi mila.</div>
            ) : (
              searchResults.map((m) => (
                <button
                  key={m.id}
                  onClick={() => jumpToMessage(m)}
                  className="w-full text-left px-4 py-3 border-b hover:bg-fg/5"
                >
                  <div className="text-[10px] text-muted mb-0.5">
                    {m.sender_role === "customer" ? "Customer" : m.sender_name || "Store"} ·{" "}
                    {new Date(m.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                  </div>
                  <div className="text-xs text-fg truncate">{previewText(m)}</div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Phase 9 Feature 4: internal notes — staff-only, same full-panel
          pattern as the search overlay above. Never rendered for a
          customer session (me.role === "customer" never opens showNotes
          since the trigger button itself is staff-only). */}
      {showNotes && (
        <div className="absolute inset-0 z-20 flex flex-col" style={{ backgroundColor: "var(--color-bg)" }}>
          <div className="px-4 py-3 border-b flex items-center gap-2">
            <StickyNote size={15} className="text-muted shrink-0" />
            <div className="flex-1 text-sm font-semibold text-fg truncate">Internal notes</div>
            <button onClick={() => setShowNotes(false)} className="text-muted hover:text-fg shrink-0">
              <X size={18} />
            </button>
          </div>

          <div className="px-3 pt-2.5 pb-2 border-b shrink-0 flex items-center gap-2">
            <input
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddNote()}
              placeholder="Note likho — sirf staff ko dikhega, customer ko nahi…"
              className="flex-1 min-w-0 px-3 py-2 rounded-full bg-surface border text-xs text-fg focus:outline-none focus:ring-2 focus:ring-brand/50"
            />
            <button
              onClick={handleAddNote}
              disabled={!noteText.trim() || savingNote}
              className="w-9 h-9 rounded-full bg-brand text-white flex items-center justify-center disabled:opacity-40 shrink-0"
              aria-label="Note add karo"
            >
              {savingNote ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {notesLoading ? (
              <div className="px-4 py-8 text-center text-xs text-muted">Load ho raha hai…</div>
            ) : notes.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted">
                Abhi koi internal note nahi hai. Sirf staff ke liye — customer ko kabhi nahi dikhega.
              </div>
            ) : (
              notes.map((n) => (
                <div key={n.id} className="px-4 py-3 border-b">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="text-[10px] font-semibold text-brand truncate">{n.author_name || "Staff"}</div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-muted">
                        {new Date(n.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                      </span>
                      {(n.author_id === me.id || me.role === "owner") && (
                        <button
                          onClick={() => handleDeleteNote(n.id)}
                          className="text-muted hover:text-danger"
                          aria-label="Note delete karo"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-fg whitespace-pre-wrap [overflow-wrap:anywhere]">{n.body}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      </DebugErrorBoundary>

      <div className="px-2.5 sm:px-4 py-2.5 border-b flex items-center justify-between shrink-0 gap-1 bg-app">
        <div className="flex items-center gap-1.5 min-w-0">
          {showBackButton && onBack && (
            <button
              onClick={onBack}
              className="md:hidden w-7 h-7 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 shrink-0"
              aria-label="Back"
            >
              <ArrowLeft size={17} />
            </button>
          )}
          <div className="min-w-0">
            <div className="font-semibold text-sm truncate text-fg">{headerTitle}</div>
            <div className="text-[11px] text-muted truncate">
              {otherTyping ? <span className="text-brand">typing…</span> : headerSubtitle}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-0.5 sm:gap-1.5 shrink-0">
          <button
            onClick={() => {
              setShowCannedResponses(false);
              setShowAttachMenu(false);
              setShowSearch(true);
            }}
            className="w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 shrink-0"
            aria-label="Search in conversation"
            title="Is conversation mein search karo"
          >
            <Search size={15} />
          </button>
          <button
            onClick={() => handleStartCall("voice")}
            className="w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 shrink-0"
            aria-label="Voice call"
          >
            <Phone size={15} />
          </button>
          <button
            onClick={() => handleStartCall("video")}
            className="w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 shrink-0"
            aria-label="Video call"
          >
            <Video size={15} />
          </button>
          {me.role !== "customer" && conversation && (
            <ChatToolsMenu
              assignedTo={conversation.assigned_to}
              staffList={staffList}
              onAssign={handleAssign}
              onOpenNotes={() => {
                setShowAssignMenu(false);
                setShowNotes(true);
              }}
              open={showAssignMenu}
              onOpenChange={setShowAssignMenu}
              menuRef={assignMenuRef}
            />
          )}
          {me.role !== "customer" && conversation && (
            <select
              value={conversation.status}
              onChange={(e) => handleStatusChange(e.target.value as ConversationStatus)}
              className={`max-w-[76px] sm:max-w-none text-[10px] sm:text-[11px] font-semibold rounded-full pl-2 pr-1 sm:px-2 py-1 border-0 focus:outline-none focus:ring-2 focus:ring-brand/50 shrink-0 ${
                STATUS_OPTIONS.find((s) => s.value === conversation.status)?.className || "bg-fg/10 text-muted"
              }`}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value} className="bg-surface text-fg">
                  {s.label}
                </option>
              ))}
            </select>
          )}
          {busy && <Loader2 size={16} className="animate-spin text-muted" />}
        </div>
      </div>

      {/* Phase 8: pinned message bar */}
      {pinnedMessages.length > 0 && (
        <button
          onClick={() => jumpToMessage(pinnedMessages[0])}
          className="px-4 py-2 border-b bg-brand/5 flex items-center gap-2 text-left shrink-0"
        >
          <Pin size={13} className="text-brand shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] text-muted">
              {pinnedMessages.length > 1 ? `${pinnedMessages.length} pinned messages` : "Pinned message"}
            </div>
            <div className="text-xs text-fg truncate">{previewText(pinnedMessages[0])}</div>
          </div>
        </button>
      )}

      {errorMsg && (
        <div className="px-4 py-2 bg-danger/10 border-b border-danger/20 flex items-center gap-2">
          <AlertCircle size={14} className="text-danger shrink-0" />
          <span className="text-xs text-danger">{errorMsg}</span>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        className={`flex-1 overflow-y-auto px-4 pt-4 ${reserveBottomSpace ? "pb-24" : "pb-4"}`}
      >
        {hasMoreOlder && (
          <div className="flex justify-center mb-3">
            <button
              onClick={loadOlderMessages}
              disabled={loadingOlder}
              className="flex items-center gap-1.5 text-xs text-muted hover:text-fg bg-fg/5 hover:bg-fg/10 rounded-full px-3 py-1.5 disabled:opacity-50"
            >
              {loadingOlder ? <Loader2 size={12} className="animate-spin" /> : <ChevronUp size={12} />}
              {loadingOlder ? "Load ho raha hai…" : "Purane messages dekhein"}
            </button>
          </div>
        )}

        <DebugErrorBoundary label="Message list / action row">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-muted text-center px-6">
            Koi message nahi hai abhi — pehla message bhejo.
          </div>
        ) : (
          messages.map((m) => {
            const isMine = m.sender_id === me.id;
            const otherLastReadAt =
              chatRole === "customer" ? conversation?.owner_last_read_at : conversation?.customer_last_read_at;
            const isRead = isMine && !!otherLastReadAt && otherLastReadAt >= m.created_at;
            return (
              <div
                key={m.id}
                className={highlightId === m.id ? "bg-brand/10 rounded-xl transition-colors duration-700 -mx-1 px-1" : ""}
              >
                <MessageBubble
                  message={m}
                  isMine={isMine}
                  isRead={isRead}
                  showSeenLabel={m.id === lastMineId}
                  reactions={reactionsByMessage[m.id] || []}
                  myUserId={me.id}
                  repliedMessage={m.reply_to_id ? messages.find((x) => x.id === m.reply_to_id) || null : null}
                  isActive={activeMessageId === m.id}
                  onToggleActive={() => setActiveMessageId((prev) => (prev === m.id ? null : m.id))}
                  onReply={() => handleReplyStart(m)}
                  onEdit={() => handleEditStart(m)}
                  onDelete={() => handleDeleteMessage(m)}
                  onTogglePin={() => handleTogglePin(m)}
                  onReact={(emoji) => handleReact(m, emoji)}
                  onJumpToReply={jumpToMessageId}
                />
              </div>
            );
          })
        )}
        </DebugErrorBoundary>
        <div ref={bottomRef} />
      </div>

      {/* Phase 8: reply preview bar */}
      {replyingTo && (
        <div className="px-3 pt-2 flex items-center gap-2 bg-app">
          <div className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-fg/5 border-l-2 border-brand/60">
            <div className="text-[10px] text-brand font-semibold">Replying to</div>
            <div className="text-xs text-muted truncate">{previewText(replyingTo)}</div>
          </div>
          <button
            onClick={handleCancelReply}
            className="w-7 h-7 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Phase 8: edit mode bar */}
      {editingMessage && (
        <div className="px-3 pt-2 flex items-center gap-2 bg-app">
          <div className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-fg/5 border-l-2 border-warning/60 flex items-center gap-1.5">
            <Pencil size={12} className="text-warning shrink-0" />
            <div className="text-xs text-muted truncate">Editing message</div>
          </div>
          <button
            onClick={handleCancelEdit}
            className="w-7 h-7 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Attachment drawer — location / product / quick-replies live here
          instead of cramming every icon into the main bar. Opens above
          the input, big labeled rows are much easier to hit on mobile
          than a row of 9x9 icons. */}
      {showAttachMenu && (
        <div className="px-3 pt-2.5 pb-1 border-t shrink-0 bg-app">
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => {
                setShowAttachMenu(false);
                handleShareLocation();
              }}
              className="flex flex-col items-center gap-1.5 py-3 rounded-xl bg-fg/5 hover:bg-fg/10 text-fg"
            >
              <span className="w-11 h-11 rounded-full bg-success/15 text-success flex items-center justify-center">
                <MapPin size={20} />
              </span>
              <span className="text-[11px] font-medium">Location</span>
            </button>
            {me.role !== "customer" && (
              <button
                onClick={() => {
                  setShowAttachMenu(false);
                  setShowCannedResponses(false);
                  setShowSearch(false);
                  setShowProductPicker(true);
                }}
                className="flex flex-col items-center gap-1.5 py-3 rounded-xl bg-fg/5 hover:bg-fg/10 text-fg"
              >
                <span className="w-11 h-11 rounded-full bg-brand/15 text-brand flex items-center justify-center">
                  <Package size={20} />
                </span>
                <span className="text-[11px] font-medium">Product</span>
              </button>
            )}
            {me.role !== "customer" && (
              <button
                onClick={() => {
                  setShowAttachMenu(false);
                  setShowProductPicker(false);
                  setShowSearch(false);
                  setShowCannedResponses(true);
                }}
                className="flex flex-col items-center gap-1.5 py-3 rounded-xl bg-fg/5 hover:bg-fg/10 text-fg"
              >
                <span className="w-11 h-11 rounded-full bg-warning/15 text-warning flex items-center justify-center">
                  <Zap size={20} />
                </span>
                <span className="text-[11px] font-medium">Quick reply</span>
              </button>
            )}
          </div>
        </div>
      )}

      <div className="p-3 border-t shrink-0 bg-app">
        <div className="flex items-center gap-1.5">
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleImageSelected} />
          <button
            onClick={() => setShowAttachMenu((v) => !v)}
            className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition-transform ${
              showAttachMenu ? "bg-brand/15 text-brand rotate-45" : "text-muted hover:bg-fg/5"
            }`}
            title="More options"
            aria-label="More options"
          >
            <Plus size={22} />
          </button>
          <button
            onClick={handlePickImage}
            className="w-11 h-11 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 shrink-0"
            title="Send image"
            aria-label="Send image"
          >
            <ImageIcon size={21} />
          </button>
          <button
            onClick={handleToggleRecording}
            className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${
              recording ? "bg-danger text-white" : "text-muted hover:bg-fg/5"
            }`}
            title={recording ? "Stop recording" : "Record voice note"}
            aria-label={recording ? "Stop recording" : "Record voice note"}
          >
            {recording ? <Square size={19} /> : <Mic size={21} />}
          </button>

          <input
            ref={inputRef}
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSendText()}
            onFocus={() => setShowAttachMenu(false)}
            placeholder={editingMessage ? "Message edit karo…" : "Message likho…"}
            className="flex-1 min-w-0 px-4 py-3 rounded-full bg-surface border text-sm text-fg focus:outline-none focus:ring-2 focus:ring-brand/50"
          />
          <button
            onClick={handleSendText}
            disabled={!text.trim()}
            className="w-11 h-11 rounded-full bg-brand text-white flex items-center justify-center disabled:opacity-40 shrink-0"
            aria-label="Send"
          >
            {editingMessage ? <Pencil size={17} /> : <Send size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
//  ChatToolsMenu — Phase 9 Features 3 & 4, staff-only.
//  Consolidated into one popover (instead of a separate always-visible
//  "Assign to" <select> + a separate Notes icon) on purpose — the
//  header row here is already tight with Search/Voice/Video/Status on
//  mobile (see MessageBubble.tsx reply-quote bug fixed earlier: this
//  header has the exact same narrow-screen squeeze risk), so both
//  actions share a single kebab button instead of adding two more.
// ============================================================
function ChatToolsMenu({
  assignedTo,
  staffList,
  onAssign,
  onOpenNotes,
  open,
  onOpenChange,
  menuRef,
}: {
  assignedTo: string | null;
  staffList: Profile[];
  onAssign: (staffId: string | null) => void;
  onOpenNotes: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  menuRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        title="Assign / Internal notes"
        aria-label="Conversation tools"
        aria-expanded={open}
        className={`w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 shrink-0 ${
          open ? "bg-fg/10" : ""
        }`}
      >
        <MoreVertical size={15} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-30 bg-surface border rounded-xl shadow-lg py-1 min-w-[190px] max-h-[70vh] overflow-y-auto">
          <div className="px-3 py-1.5 text-[10px] font-semibold text-muted uppercase tracking-wide">Assign to</div>
          <button
            type="button"
            onClick={() => onAssign(null)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-fg/5 ${
              !assignedTo ? "text-brand font-semibold" : "text-fg"
            }`}
          >
            <UserX size={13} className="shrink-0 text-muted" />
            Unassigned
          </button>
          {staffList.map((s) => (
            <button
              type="button"
              key={s.id}
              onClick={() => onAssign(s.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-fg/5 ${
                assignedTo === s.id ? "text-brand font-semibold" : "text-fg"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.is_away ? "bg-warning" : "bg-success"}`} />
              <span className="truncate">{s.name || s.email}</span>
            </button>
          ))}

          <div className="border-t my-1" />
          <button
            type="button"
            onClick={onOpenNotes}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-fg hover:bg-fg/5"
          >
            <StickyNote size={13} className="shrink-0 text-muted" />
            Internal notes
          </button>
        </div>
      )}
    </div>
  );
}
