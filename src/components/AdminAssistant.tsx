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
import { useCall } from "./CallManager";

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
      text: `Salam! Main ${ASSISTANT_NAME} hoon. Aapke inbox ka live data mere paas hai — reply bhejwana ho, kisi customer ki chat kholni ho, usse call milani ho, location bhejni ho, ya status/tags badalne hon, bol kar ya likh kar bata dein.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const suggestions = selected
    ? ["Is customer ko batao order kab tak deliver hoga", "Isko voice call milao", "Location bhej do", "Iss conversation ko urgent kar do"]
    : ["Kitni conversations open hain", "Ahmed wali chat kholo", "Urgent conversations dikhao", "Colorful theme laga do"];
  const endRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const { mode: themeMode, setTheme } = useTheme();
  // Same CallManager instance OwnerInboxScreen already wraps this
  // component in — ABI places calls exactly the way tapping the
  // phone/video icon in ChatWindow's header would (same ringing UI,
  // same DB rows, same everything). `callPhase` lets ABI know the
  // instant a call is ringing/active so it can go fully quiet.
  const { startCall, phase: callPhase } = useCall();
  const callInProgress = callPhase !== "idle";

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
  // pause: isSpeaking (mic mutes while ABI is talking, so it never picks
  // up its own voice) OR callInProgress (mic mutes for the ENTIRE
  // duration of any ringing/active call — a live call already has its
  // own mic via getUserMedia, and ABI has no business listening in on a
  // call or answering over it).
  const { isSupported: voiceSupported, isListening, interimTranscript, toggleListening, stopListening } = useVoiceInput({
    onResult: (transcript) => send(transcript),
    onError: (message) => toastError(message),
    lang: "en-US",
    pause: isSpeaking || callInProgress,
  });

  // ---- Go completely silent + get out of the way the instant any call
  // starts (outgoing, incoming, or active) — this is what makes ABI stop
  // "running in the background" during a call. Mic already stops via the
  // `pause` flag above; this additionally cuts short any TTS speech in
  // progress and auto-minimizes the full-screen panel so the call screen
  // isn't competing with it. Everything resumes automatically once
  // callPhase goes back to "idle". ----
  const prevCallInProgressRef = useRef(false);
  useEffect(() => {
    if (callInProgress && !prevCallInProgressRef.current) {
      stopListening();
      if (ttsSupported && isSpeaking) {
        // Cuts off mid-sentence TTS immediately rather than letting it
        // finish over the call's own ringing/audio.
        window.speechSynthesis?.cancel();
      }
      if (mode === "full") onMinimize();
    }
    prevCallInProgressRef.current = callInProgress;
  }, [callInProgress]);

  const addBotMessage = (text: string) => {
    setMessages((m) => [...m, { role: "bot", text }]);
    // Never speak over/into a live or ringing call.
    if (!callInProgress) speak(text);
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
      if (ok) {
        toastSuccess("Reply bhej diya.");
      } else {
        // IMPORTANT: this is the actual outcome, not the LLM's guess.
        // The chat bubble above already said "sent" (that's just the
        // model's spoken-friendly reply, written before this ran) — if
        // the real send failed, ABI now says so explicitly in the chat
        // (and out loud, if voice is on) instead of only flashing a
        // toast the admin could easily miss.
        toastError("Reply bhejne mein masla hua.");
        addBotMessage("Sorry — message actually nahi ja saka (network ya server issue). Dobara try karein.");
      }
      return;
    }

    if (action.type === "send_location") {
      if (!selected) {
        addBotMessage("Location kis conversation mein bhejni hai? Pehle ek conversation select karein.");
        return;
      }
      if (!navigator.geolocation) {
        addBotMessage("Is browser/device mein location support nahi hai.");
        return;
      }
      const identity = { senderName: me.name || me.email || undefined, senderTitle: (me.role === "owner" ? "Owner" : "Agent") as "Owner" | "Agent" };
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const ok = await sendMessage({
            conversationId: selected.id,
            senderId: me.id,
            senderRole: "owner",
            kind: "location",
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            ...identity,
          });
          if (ok) addBotMessage("Location bhej di.");
          else addBotMessage("Location bhejne mein masla hua — dobara try karein.");
        },
        (err) => {
          let msg = "Location access nahi mil saki.";
          if (err.code === 1) msg = "Location permission denied hai — browser settings mein allow karein.";
          if (err.code === 2) msg = "Location unavailable hai — GPS/network check karein.";
          if (err.code === 3) msg = "Location request timeout ho gaya.";
          addBotMessage(msg);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
      return;
    }

    if (action.type === "toggle_ai_mode") {
      if (!selected) {
        addBotMessage("Kis conversation ke liye? Pehle ek conversation select karein.");
        return;
      }
      const ok = await toggleAiMode(selected.id, action.enabled);
      if (!ok) addBotMessage("AI auto-reply badalne mein masla hua — dobara try karein.");
      onDataChanged();
      return;
    }

    if (action.type === "set_status") {
      if (!selected) {
        addBotMessage("Kis conversation ka status? Pehle ek conversation select karein.");
        return;
      }
      if (!STATUS_VALUES.includes(action.status)) return;
      const ok = await updateConversationStatus(selected.id, action.status);
      if (!ok) addBotMessage("Status badalne mein masla hua — dobara try karein.");
      onDataChanged();
      return;
    }

    if (action.type === "set_tags") {
      if (!selected) {
        addBotMessage("Kis conversation ke tags? Pehle ek conversation select karein.");
        return;
      }
      const ok = await updateConversationTags(selected.id, action.tags);
      if (!ok) addBotMessage("Tags badalne mein masla hua — dobara try karein.");
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

    if (action.type === "start_call") {
      if (callInProgress) {
        addBotMessage("Pehle se hi ek call chal rahi hai.");
        return;
      }
      // "query" given -> find + open that customer first, same as
      // select_conversation. No query -> use whatever's already open.
      let target = selected;
      if (action.query) {
        const match = findConversation(action.query);
        if (!match) {
          addBotMessage(`"${action.query}" se milti koi conversation nahi mili.`);
          return;
        }
        target = match;
        onSelectConversation(match);
      }
      if (!target) {
        addBotMessage("Kis customer ko call karni hai? Naam ya number bata dein, ya pehle conversation select kar lein.");
        return;
      }
      const label = target.customer_name || target.customer_email || "Customer";
      startCall(target.id, action.kind, label);
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

    return `You are "${ASSISTANT_NAME}" — the admin's assistant for the ABOS Chat inbox (${me.role === "owner" ? "Owner" : "Agent"}: ${me.name || me.email}). You help the admin manage customer conversations by voice or text: sending replies, opening a customer's chat, placing voice/video calls, sharing your (the admin's) current location, changing conversation status/tags, toggling AI auto-reply, filtering the inbox, and drafting broadcasts.

You also have two READ tools available on the server (call them directly, you don't need to ask permission):
- lookup_products(query?) — live product stock/price from the real catalog. Use this instead of guessing whenever the admin asks about a product's price or stock.
- lookup_customer_orders() — the currently SELECTED customer's real order history. Use this instead of guessing whenever the admin asks about a customer's orders or delivery status. Needs a conversation selected first.

"Handling" a customer fully (answering their product questions and taking their orders automatically, in their own chat) is a separate, already-existing feature: toggle_ai_mode(enabled:true) turns on "ABOS Assistant" for that specific conversation — a dedicated sales/support bot (different from you) that then replies to that customer directly and can place real orders on their behalf. Use toggle_ai_mode when the admin asks you to "handle"/"look after"/"reply automatically to" a customer.

Conversations (most recent first, id | name (number) | status | ai_mode | unread | tags):
${list || "No conversations yet."}

${selectedBlock}

Respond with STRICT JSON ONLY, no markdown, no code fences, in this exact shape:
{"reply": "short spoken-friendly reply in Roman Urdu/English mix, matching the admin's own language", "action": null | {...}}

Valid "action" values (omit or use null if the admin is just asking a question):
- {"type":"send_message","text":"..."} — send a text reply in the currently selected conversation
- {"type":"send_location"} — share the admin's current device location in the currently selected conversation (needs a conversation selected; browser will ask the admin for location permission if not already granted)
- {"type":"toggle_ai_mode","enabled":true|false} — turn AI auto-reply on/off for the selected conversation
- {"type":"set_status","status":"open"|"pending"|"urgent"|"resolved"} — change the selected conversation's status
- {"type":"set_tags","tags":["tag1","tag2"]} — replace the selected conversation's tags
- {"type":"filter_status","status":"all"|"open"|"pending"|"urgent"|"resolved"} — change which status tab the inbox list shows
- {"type":"select_conversation","query":"name or number to search for"} — open a different customer's chat screen
- {"type":"prepare_broadcast","text":"...","tag":"optional tag"} — draft a broadcast message (this only opens the composer pre-filled, it never sends by itself — always tell the admin they still need to tap Send)
- {"type":"start_call","kind":"voice"|"video","query":"optional name or number"} — place a real voice or video call to a customer. If "query" is given, open that customer's chat first, then call them. If omitted, call whoever's currently selected.

Rules:
- Never invent data that isn't in the conversation list above.
- Only use send_message/send_location/toggle_ai_mode/set_status/set_tags when a conversation is selected; if none is selected, ask the admin to pick one instead of guessing.
- start_call is the one exception: it can include "query" even when nothing is selected yet — you don't need the admin to select first, just include who to call in "query".
- Your "reply" describes what you're ABOUT to do, in good faith — it is not a guaranteed confirmation. The app will separately tell the admin if the action actually failed, so don't overstate certainty (avoid absolute past-tense claims like "done"/"sent" — prefer "bhejwa raha hoon" style phrasing).
- Keep "reply" short — it may be read aloud.
- Do not use markdown formatting (no **, no bullet lists) since replies may be spoken.`;
  };

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || sendingRef.current) return;

    // ABI takes no commands at all while a call is ringing/active — the
    // admin's mic is already stopped in this state (see pause above),
    // but this also blocks anything sent from the text box.
    if (callInProgress) return;

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
      const raw = await callAdminAssistant(buildSystemPrompt(), messages, q, selected?.id ?? null);
      const { reply, action } = parseAssistantReply(raw);
      addBotMessage(reply);
      if (action) await runAction(action);
    } catch (err: any) {
      const status = err?.status;
      const text =
        status === 429
          ? "Abhi thora zyada traffic hai is liye jawab dene mein dair lag rahi hai — 30 second baad dobara try karein."
          : status === 401
          ? "Aapka session expire ho gaya lagta hai — dobara login karein."
          : status === 403
          ? "Aapke account ko owner/agent access nahi mila — apna role check karwayein."
          : status === 500 && /GROQ_API_KEY/i.test(err?.detail?.error || err?.message || "")
          ? "AI service configure nahi hai (API key missing) — admin ko batayein."
          : "Maaf kijiye, is waqt assistant tak nahi pohanch saka — thodi dair mein dobara koshish karein.";
      addBotMessage(text);
    } finally {
      setLoading(false);
      sendingRef.current = false;
    }
  };

  // A call is ringing/active — don't render ABI's floating bubble or
  // full panel at all, so it visually gets completely out of the way
  // and can't be tapped/typed into mid-call. It reappears automatically
  // the instant callPhase goes back to "idle".
  if (callInProgress) return null;

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
