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
} from "lucide-react";
import { ChatMessage, Profile, Conversation, ProductSnapshot, ConversationStatus } from "../lib/types";
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
} from "../lib/chatApi";
import MessageBubble from "./MessageBubble";
import ProductPicker from "./ProductPicker";
import { useCall } from "./CallManager";

const STATUS_OPTIONS: { value: ConversationStatus; label: string; className: string }[] = [
  { value: "open", label: "Open", className: "bg-accent/15 text-accent" },
  { value: "pending", label: "Pending", className: "bg-warning/15 text-warning" },
  { value: "urgent", label: "Urgent", className: "bg-danger/15 text-danger" },
  { value: "resolved", label: "Resolved", className: "bg-success/15 text-success" },
];

/** Store-side display identity attached to every message this user
 *  sends — undefined for customers, since their own bubble already
 *  shows who they are via isMine. */
function staffIdentity(me: Profile) {
  if (me.role === "customer") return {};
  return { senderName: me.name || me.email || undefined, senderTitle: (me.role === "owner" ? "Owner" : "Agent") as "Owner" | "Agent" };
}

interface ChatWindowProps {
  conversationId: string;
  me: Profile;
  headerTitle: string;
  headerSubtitle?: string;
  onBack?: () => void;
  showBackButton?: boolean;
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
  // Agents share the "owner" side of the conversation for read-receipts,
  // typing indicators, and sender_role — their distinct identity is
  // carried separately via sender_name/sender_title.
  const chatRole: "customer" | "owner" = me.role === "customer" ? "customer" : "owner";
  const { startCall } = useCall();

  const handleStartCall = (kind: "voice" | "video") => {
    startCall(conversationId, kind, headerTitle);
  };
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const lastMessageIdRef = useRef<string | null>(null);
  const typingApiRef = useRef<ReturnType<typeof subscribeToTyping> | null>(null);

  const mergeMessages = (incoming: ChatMessage[]) => {
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return Array.from(byId.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
  };

  useEffect(() => {
    let unsubMessages = () => {};
    let unsubConversation = () => {};
    let pollId: ReturnType<typeof setInterval>;

    (async () => {
      const [page, convo] = await Promise.all([listMessages(conversationId), getConversation(conversationId)]);
      setMessages(page.messages);
      setHasMoreOlder(page.hasMore);
      setConversation(convo);
      markConversationRead(conversationId, chatRole);

      unsubMessages = subscribeToMessages(conversationId, (msg) => {
        mergeMessages([msg]);
        markConversationRead(conversationId, chatRole);
      });
      unsubConversation = subscribeToConversation(conversationId, (updated) => setConversation(updated));

      pollId = setInterval(async () => {
        const latest = await listMessages(conversationId);
        mergeMessages(latest.messages);
      }, 4000);
    })();

    typingApiRef.current = subscribeToTyping(conversationId, chatRole, setOtherTyping);

    return () => {
      unsubMessages();
      unsubConversation();
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
    setText("");
    typingApiRef.current?.setTyping(false);
    await sendMessage({
      conversationId,
      senderId: me.id,
      senderRole: chatRole,
      kind: "text",
      body,
      ...staffIdentity(me),
    });
  };

  const handleStatusChange = async (status: ConversationStatus) => {
    if (!conversation) return;
    setConversation({ ...conversation, status });
    await updateConversationStatus(conversation.id, status);
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

  return (
    <div className="relative flex flex-col h-full">
      {showProductPicker && <ProductPicker onPick={handlePickProduct} onClose={() => setShowProductPicker(false)} />}

      {/* Header */}
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

      {/* Error toast */}
      {errorMsg && (
        <div className="px-4 py-2 bg-danger/10 border-b border-danger/20 flex items-center gap-2">
          <AlertCircle size={14} className="text-danger shrink-0" />
          <span className="text-xs text-danger">{errorMsg}</span>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-4">
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
            return <MessageBubble key={m.id} message={m} isMine={isMine} isRead={isRead} />;
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="p-3 border-t shrink-0 bg-app">
        <div className="flex items-center gap-1.5">
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleImageSelected} />
          <button
            onClick={handlePickImage}
            className="w-9 h-9 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 shrink-0"
            title="Send image"
          >
            <ImageIcon size={17} />
          </button>
          <button
            onClick={handleShareLocation}
            className="w-9 h-9 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 shrink-0"
            title="Share location"
          >
            <MapPin size={17} />
          </button>
          {me.role !== "customer" && (
            <button
              onClick={() => setShowProductPicker(true)}
              className="w-9 h-9 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 shrink-0"
              title="Send product"
            >
              <Package size={17} />
            </button>
          )}
          <button
            onClick={handleToggleRecording}
            className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
              recording ? "bg-danger text-white" : "text-muted hover:bg-fg/5"
            }`}
            title={recording ? "Stop recording" : "Record voice note"}
          >
            {recording ? <Square size={15} /> : <Mic size={17} />}
          </button>

          <input
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSendText()}
            placeholder="Message likho…"
            className="flex-1 px-3.5 py-2.5 rounded-full bg-surface border text-sm text-fg focus:outline-none focus:ring-2 focus:ring-brand/50"
          />
          <button
            onClick={handleSendText}
            disabled={!text.trim()}
            className="w-9 h-9 rounded-full bg-brand text-white flex items-center justify-center disabled:opacity-40 shrink-0"
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
