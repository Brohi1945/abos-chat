import React, { useEffect, useRef, useState } from "react";
import { Send, Image as ImageIcon, MapPin, Mic, Square, Loader2 } from "lucide-react";
import { ChatMessage, Profile } from "../lib/types";
import { listMessages, sendMessage, subscribeToMessages, uploadMedia, triggerAIReply } from "../lib/chatApi";
import MessageBubble from "./MessageBubble";

interface ChatWindowProps {
  conversationId: string;
  me: Profile;
  headerTitle: string;
  headerSubtitle?: string;
  /** When true and `me` is the customer, an AI reply is requested after each message they send. */
  aiMode?: boolean;
}

export default function ChatWindow({ conversationId, me, headerTitle, headerSubtitle, aiMode }: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
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
    if (!navigator.geolocation) return;
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
      () => setBusy(false),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  const handleToggleRecording = async () => {
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        setBusy(true);
        const url = await uploadMedia(blob, `conversations/${conversationId}`, "webm");
        setBusy(false);
        if (url) {
          await sendMessage({ conversationId, senderId: me.id, senderRole: me.role, kind: "voice", mediaUrl: url });
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      // mic permission denied or unavailable — silently no-op, button just won't start.
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div>
          <div className="font-semibold text-sm">{headerTitle}</div>
          {headerSubtitle && <div className="text-[11px] text-slate-500">{headerSubtitle}</div>}
        </div>
        {busy && <Loader2 size={16} className="animate-spin text-slate-500" />}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-500">
            Koi message nahi hai abhi — pehla message bhejo.
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} isMine={m.sender_id === me.id} />)
        )}
        <div ref={bottomRef} />
      </div>

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
            title="Record voice note"
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
