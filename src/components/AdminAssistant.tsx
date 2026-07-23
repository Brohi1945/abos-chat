import React, { useEffect, useRef, useState } from "react";
import { Send, Loader2, Mic, MicOff, Volume2, VolumeX, Bot, ChevronDown } from "lucide-react";
import { useTheme } from "../theme";
import { Profile, OwnerInboxRow, ConversationStatus } from "../lib/types";
import { sendMessage, toggleAiMode, updateConversationStatus, updateConversationTags } from "../lib/chatApi";
import { callAdminAssistant, parseAssistantReply, TypingDots, AdminAssistantAction } from "../lib/adminAssistantApi";
import { useVoiceInput } from "../lib/useVoiceInput";
import { useVoiceOutput } from "../lib/useVoiceOutput";
import { detectVoiceToggleCommand, detectThemeCommand } from "../lib/voiceCommands";
import { toastError, toastSuccess } from "../lib/toast";

interface Message {
  role: "user" | "bot";
  text: string;
}

// Change the assistant's name in exactly one place.
const ASSISTANT_NAME = "ABI";

const STATUS_VALUES: ConversationStatus[] = ["open", "pending", "urgent", "resolved"];

interface AdminAssistantProps {
  me: Profile;
  conversations: OwnerInboxRow[];
  selected: OwnerInboxRow | null;
  onSelectConversation: (conv: OwnerInboxRow) => void;
  onStatusFilterChange: (status: "all" | ConversationStatus) => void;
  onDataChanged: () => void;
  onOpenBroadcastDraft: (text: string, tag?: string) => void;
  // Persistent overlay (mounted once in OwnerInboxScreen, never torn
  // down just because the admin selects a different conversation) so
  // voice input/output survives navigation instead of getting cut off
  // mid-sentence. "mode" controls full-screen vs a small floating bubble.
  mode: "full" | "minimized";
  onMinimize: () => void;
  onExpand: () => void;
}

export default function AdminAssistant({
  me,
  conversations,
  selected,
  onSelectConversation,
  onStatusFilterChange,
  onDataChanged,
  onOpenBroadcastDraft,
  mode,
  onMinimize,
  onExpand,
}: AdminAssistantProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "bot",
      text: `Salam! Main ${ASSISTANT_NAME} hoon. Aapke inbox ka live data mere paas hai — reply bhejwana ho, status/tags badalne hon, ya theme change karni ho, bol kar ya likh kar bata dein.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const suggestions = selected
    ? ["Is customer ko batao order kab tak deliver hoga", "Iss conversation ko urgent kar do", "AI auto-reply on kar do", "Colorful theme laga do"]
    : ["Kitni conversations open hain", "Urgent conversations dikhao", "Dark theme laga do", "Colorful theme laga do"];
  const endRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const { mode: themeMode, setTheme } = useTheme();

  const THEME_LABELS: Record<string, string> = {
    light: "Light",
    dark: "Dark",
    colorful: "Colorful",
  };

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  // AI's replies are spoken aloud too — Siri/Alexa style. Off by
  // default, admin turns it on via the speaker icon.
  const { isSupported: ttsSupported, isSpeaking, voiceEnabled, toggleVoiceEnabled, speak, speakUnlocked } = useVoiceOutput({
    lang: "en-IN",
  });

  // Voice command: admin can speak commands too ("iss conversation ko
  // resolved kar do") — whatever's said is sent straight through send().
  // pause: isSpeaking — mic mutes itself while ABI is talking so it
  // never picks up its own voice as a new command.
  const { isSupported: voiceSupported, isListening, interimTranscript, toggleListening } = useVoiceInput({
    onResult: (transcript) => send(transcript),
    onError: (message) => toastError(message),
    lang: "en-US",
    pause: isSpeaking,
  });

  const addBotMessage = (text: string) => {
    setMessages((m) => [...m, { role: "bot", text }]);
    speak(text);
  };

  // Very small, forgiving fuzzy match against name / number / email —
  // good enough for "Ahmed wali conversation kholo" style commands.
  const findConversation = (query: string): OwnerInboxRow | null => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return (
      conversations.find(
        (c) =>
          c.customer_name?.toLowerCase().includes(q) ||
          c.customer_number?.toLowerCase().includes(q) ||
          c.customer_email?.toLowerCase().includes(q)
      ) || null
    );
  };

  const runAction = async (action: AdminAssistantAction) => {
    if (action.type === "send_message") {
      if (!selected) {
        addBotMessage("Pehle ek conversation select karein, phir main reply bhej dunga.");
        return;
      }
      const identity = { senderName: me.name || me.email || undefined, senderTitle: (me.role === "owner" ? "Owner" : "Agent") as "Owner" | "Agent" };
      const ok = await sendMessage({
        conversationId: selected.id,
        senderId: me.id,
        senderRole: "owner",
        kind: "text",
        body: action.text,
        ...identity,
      });
      if (ok) toastSuccess("Reply bhej diya.");
      else toastError("Reply bhejne mein masla hua.");
      return;
    }

    if (action.type === "toggle_ai_mode") {
      if (!selected) {
        addBotMessage("Kis conversation ke liye? Pehle ek conversation select karein.");
        return;
      }
      await toggleAiMode(selected.id, action.enabled);
      onDataChanged();
      return;
    }

    if (action.type === "set_status") {
      if (!selected) {
        addBotMessage("Kis conversation ka status? Pehle ek conversation select karein.");
        return;
      }
      if (!STATUS_VALUES.includes(action.status)) return;
      await updateConversationStatus(selected.id, action.status);
      onDataChanged();
      return;
    }

    if (action.type === "set_tags") {
      if (!selected) {
        addBotMessage("Kis conversation ke tags? Pehle ek conversation select karein.");
        return;
      }
      await updateConversationTags(selected.id, action.tags);
      onDataChanged();
      return;
    }

    if (action.type === "filter_status") {
      onStatusFilterChange(action.status);
      return;
    }

    if (action.type === "select_conversation") {
      const match = findConversation(action.query);
      if (match) onSelectConversation(match);
      else addBotMessage(`"${action.query}" se milti koi conversation nahi mili.`);
      return;
    }

    if (action.type === "prepare_broadcast") {
      onOpenBroadcastDraft(action.text, action.tag);
      return;
    }
  };

  const buildSystemPrompt = () => {
    const list = conversations
      .slice(0, 40)
      .map(
        (c) =>
          `- id=${c.id} | ${c.customer_name || c.customer_email || "Customer"} (${c.customer_number}) | status=${c.status} | ai_mode=${c.ai_mode} | unread=${c.unread_count} | tags=${(c.tags || []).join(",") || "none"}`
      )
      .join("\n");

    const selectedBlock = selected
      ? `Currently SELECTED conversation: ${selected.customer_name || selected.customer_email || "Customer"} (${selected.customer_number}), status=${selected.status}, ai_mode=${selected.ai_mode}, tags=${(selected.tags || []).join(",") || "none"}.`
      : "No conversation is currently selected.";

    return `You are "${ASSISTANT_NAME}" — the admin's assistant for the ABOS Chat inbox (${me.role === "owner" ? "Owner" : "Agent"}: ${me.name || me.email}). You help the admin manage customer conversations by voice or text: sending replies, changing conversation status/tags, toggling AI auto-reply, filtering the inbox, selecting a conversation, and drafting broadcasts.

Conversations (most recent first, id | name (number) | status | ai_mode | unread | tags):
${list || "No conversations yet."}

${selectedBlock}

Respond with STRICT JSON ONLY, no markdown, no code fences, in this exact shape:
{"reply": "short spoken-friendly reply in Roman Urdu/English mix, matching the admin's own language", "action": null | {...}}

Valid "action" values (omit or use null if the admin is just asking a question):
- {"type":"send_message","text":"..."} — send a text reply in the currently selected conversation
- {"type":"toggle_ai_mode","enabled":true|false} — turn AI auto-reply on/off for the selected conversation
- {"type":"set_status","status":"open"|"pending"|"urgent"|"resolved"} — change the selected conversation's status
- {"type":"set_tags","tags":["tag1","tag2"]} — replace the selected conversation's tags
- {"type":"filter_status","status":"all"|"open"|"pending"|"urgent"|"resolved"} — change which status tab the inbox list shows
- {"type":"select_conversation","query":"name or number to search for"} — open a different conversation
- {"type":"prepare_broadcast","text":"...","tag":"optional tag"} — draft a broadcast message (this only opens the composer pre-filled, it never sends by itself — always tell the admin they still need to tap Send)

Rules:
- Never invent data that isn't in the conversation list above.
- Only use send_message/toggle_ai_mode/set_status/set_tags when a conversation is selected; if none is selected, ask the admin to pick one instead of guessing.
- Keep "reply" short — it may be read aloud.
- Do not use markdown formatting (no **, no bullet lists) since replies may be spoken.`;
  };

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || sendingRef.current) return;

    const voiceCommand = detectVoiceToggleCommand(q);
    if (voiceCommand) {
      setMessages((m) => [...m, { role: "user", text: q }]);
      setInput("");
      if (voiceCommand === "enable") {
        if (!ttsSupported) {
          setMessages((m) => [...m, { role: "bot", text: "Maaf kijiye, is browser mein voice output support nahi hai." }]);
        } else if (voiceEnabled) {
          addBotMessage("Voice pehle se hi on hai.");
        } else {
          speakUnlocked("Voice on hai, ab main jawab bol kar dunga.");
          toggleVoiceEnabled();
          setMessages((m) => [...m, { role: "bot", text: "Voice on kar diya — ab main bol kar jawab dunga." }]);
        }
      } else {
        if (voiceEnabled) {
          toggleVoiceEnabled();
          setMessages((m) => [...m, { role: "bot", text: "Theek hai, voice off kar diya." }]);
        } else {
          addBotMessage("Voice pehle se hi off hai.");
        }
      }
      return;
    }

    const themeCommand = detectThemeCommand(q);
    if (themeCommand) {
      setMessages((m) => [...m, { role: "user", text: q }]);
      setInput("");
      if (themeCommand === themeMode) {
        addBotMessage(`${THEME_LABELS[themeCommand]} theme pehle se hi on hai.`);
      } else {
        setTheme(themeCommand);
        addBotMessage(`Theme ${THEME_LABELS[themeCommand]} kar diya.`);
      }
      return;
    }

    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setLoading(true);
    sendingRef.current = true;

    try {
      const raw = await callAdminAssistant(buildSystemPrompt(), messages, q);
      const { reply, action } = parseAssistantReply(raw);
      addBotMessage(reply);
      if (action) await runAction(action);
    } catch (err: any) {
      const status = err?.status;
      const text =
        status === 429
          ? "Abhi thora zyada traffic hai is liye jawab dene mein dair lag rahi hai — 30 second baad dobara try karein."
          : status === 401 || status === 403
          ? "Aapka session expire ho gaya lagta hai — dobara login karein."
          : status === 500 && /GROQ_API_KEY/i.test(err?.detail?.error || err?.message || "")
          ? "AI service configure nahi hai (API key missing) — admin ko batayein."
          : "Maaf kijiye, is waqt assistant tak nahi pohanch saka — thodi dair mein dobara koshish karein.";
      addBotMessage(text);
    } finally {
      setLoading(false);
      sendingRef.current = false;
    }
  };

  // ---- MINIMIZED: small floating bubble over whatever the admin is
  // looking at. Voice hooks above stay alive the whole time (this
  // component never unmounts just because the admin switches
  // conversations), so a reply mid-sentence keeps speaking through it. ----
  if (mode === "minimized") {
    return (
      <div className="fixed bottom-5 right-5 z-[60] flex items-center gap-2">
        {voiceSupported && (
          <button
            type="button"
            onClick={toggleListening}
            title={isListening ? "Stop voice input" : "Bol kar command dein"}
            className={`w-11 h-11 rounded-full flex items-center justify-center shadow-lg transition ${
              isListening ? "bg-danger text-white" : "bg-surface border text-muted hover:border-brand"
            }`}
          >
            {isListening ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        )}
        <button
          type="button"
          onClick={() => onExpand()}
          title={`${ASSISTANT_NAME} — tap to open`}
          className="flex items-center gap-2 pl-3 pr-4 py-2.5 rounded-full bg-brand text-white shadow-lg hover:opacity-90 transition"
        >
          <span className="relative flex items-center justify-center w-6 h-6 rounded-full bg-white/20 shrink-0">
            <Bot size={14} />
            {(isListening || isSpeaking) && (
              <span className="absolute inset-0 rounded-full bg-white/40 animate-ping" />
            )}
          </span>
          <span className="text-xs font-medium">
            {isListening ? "Sun raha hoon…" : isSpeaking ? "Bol raha hoon…" : ASSISTANT_NAME}
          </span>
        </button>
      </div>
    );
  }

  // ---- FULL: complete chat panel, fixed overlay above the current page. ----
  return (
    <div className="fixed inset-0 z-[60] bg-app flex flex-col p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-fg">Admin AI Assistant</h2>
        <div className="flex items-center gap-2">
          {ttsSupported && (
            <button
              type="button"
              onClick={() => {
                if (!voiceEnabled) speakUnlocked("Voice on hai, ab main jawab bol kar dunga.");
                toggleVoiceEnabled();
              }}
              title={voiceEnabled ? "Voice replies on — tap to mute" : "Voice replies off — tap to enable"}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition ${
                voiceEnabled ? "bg-brand/20 text-brand border-brand/30" : "bg-surface text-muted"
              }`}
            >
              {voiceEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
              {voiceEnabled ? "Voice on" : "Voice off"}
            </button>
          )}
          <button
            type="button"
            onClick={() => onMinimize()}
            title="Minimize"
            className="w-8 h-8 rounded-full flex items-center justify-center bg-surface border text-muted hover:border-brand shrink-0"
          >
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
      <div className="flex-1 flex flex-col min-h-0 bg-surface border rounded-xl">
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] px-4 py-2.5 text-sm rounded-2xl whitespace-pre-line ${
                m.role === "user" ? "bg-brand text-white rounded-br-md" : "bg-app text-fg border rounded-bl-md"
              }`}>
                {m.text}
              </div>
            </div>
          ))}
          {loading && <TypingDots />}
          <div ref={endRef} />
        </div>
        <div className="px-5 pb-3 flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button key={s} disabled={loading} onClick={() => send(s)} className="text-xs px-3 py-1.5 rounded-full bg-app border text-muted hover:border-brand disabled:opacity-40">
              {s}
            </button>
          ))}
        </div>
        {isListening && (
          <div className="px-5 pb-1.5">
            <div className="flex items-center gap-1.5 text-xs text-danger">
              <span className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse" />
              {interimTranscript || "Sun raha hoon…"}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 px-5 py-4 border-t">
          {voiceSupported && (
            <button
              type="button"
              onClick={toggleListening}
              disabled={loading}
              title={isListening ? "Stop voice input" : "Bol kar command dein"}
              className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition disabled:opacity-40 ${
                isListening ? "bg-danger text-white" : "bg-app border text-muted hover:border-brand"
              }`}
            >
              {isListening ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
          )}
          <input
            value={input}
            disabled={loading}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            placeholder={isListening ? "Bol rahe hain…" : "Reply bhejwayein, status badlein, ya kuch bhi poochein…"}
            className="flex-1 px-3.5 py-2.5 rounded-full bg-app border text-sm text-fg disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
          <button
            onClick={() => send()}
            disabled={loading}
            className="w-10 h-10 rounded-full bg-brand text-white flex items-center justify-center disabled:opacity-40 shrink-0"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
