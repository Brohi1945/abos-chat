import React, { useEffect, useRef, useState } from "react";
import { Send, Image as ImageIcon, MapPin, Mic, Square, Loader2, ArrowLeft, AlertCircle } from "lucide-react";
import { ChatMessage, Profile } from "../lib/types";
import { listMessages, sendMessage, subscribeToMessages, uploadMedia, triggerAIReply } from "../lib/chatApi";
import MessageBubble from "./MessageBubble";

interface ChatWindowProps {
  conversationId: string;
  me: Profile;
  headerTitle: string;
  headerSubtitle?: string;
  aiMode?: boolean;
  /** Called when mobile back button is tapped (owner inbox only) */
  onBack?: () => void;
  /** Whether to show the back arrow (mobile owner view) */
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
  aiMode,
  onBack,
  showBackButton,
}: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);

  useEffect(() => {
    let unsub = () => {};
    (async () => {
      const msgs = await listMessages(conversationId);
      setMessages(msgs);
      unsub = subscribeToMessages(conversationId, (msg) => {
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      });
    })();
    return () => unsub();
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const showError = (msg: string) => {
    setErrorMsg(msg);
    setTimeout(() => setErrorMsg(""), 4000);
  };

  const maybeTriggerAI = () => {
    if (aiMode && me.role === "customer") triggerAIReply(conversationId);
  };

  const handleSendText = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    await sendMessage({ conversationId, senderId: me.id, senderRole: me.role, kind: "text", body });
    maybeTriggerAI();
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
      await sendMessage({ conversationId, senderId: me.id, senderRole: me.role, kind: "image", mediaUrl: url });
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
          senderRole: me.role,
          kind: "location",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
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
          await sendMessage({ conversationId, senderId: me.id, senderRole: me.role, kind: "voice", mediaUrl: url });
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
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {showBackButton && onBack && (
            <button
              onClick={onBack}
              className="md:hidden w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-800 shrink-0"
              aria-label="Back"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="min-w-0">
            <div className="font-semibold text-sm truncate">{headerTitle}</div>
            {headerSubtitle && <div className="text-[11px] text-slate-500 truncate">{headerSubtitle}</div>}
          </div>
        </div>
        {busy && <Loader2 size={16} className="animate-spin text-slate-500 shrink-0 ml-2" />}
      </div>

      {/* Error toast */}
      {errorMsg && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/20 flex items-center gap-2">
          <AlertCircle size={14} className="text-red-400 shrink-0" />
          <span className="text-xs text-red-300">{errorMsg}</span>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-500 text-center px-6">
            Koi message nahi hai abhi — pehla message bhejo.
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} isMine={m.sender_id === me.id} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="p-3 border-t border-slate-800 shrink-0">
        <div className="flex items-center gap-1.5">
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleImageSelected} />
          <button
            onClick={handlePickImage}
            className="w-9 h-9 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-800 shrink-0"
            title="Send image"
          >
            <ImageIcon size={17} />
          </button>
          <button
            onClick={handleShareLocation}
            className="w-9 h-9 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-800 shrink-0"
            title="Share location"
          >
            <MapPin size={17} />
          </button>
          <button
            onClick={handleToggleRecording}
            className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
              recording ? "bg-red-500 text-white" : "text-slate-400 hover:bg-slate-800"
            }`}
            title={recording ? "Stop recording" : "Record voice note"}
          >
            {recording ? <Square size={15} /> : <Mic size={17} />}
          </button>

          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSendText()}
            placeholder="Message likho…"
            className="flex-1 px-3.5 py-2.5 rounded-full bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-brand/50"
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
