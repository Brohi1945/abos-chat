import React from "react";
import { Loader2 } from "lucide-react";
import { getAccessToken } from "./chatApi";
import { ConversationStatus } from "./types";

interface ChatTurn {
  role: "user" | "bot";
  text: string;
}

// Every action the assistant can trigger is something the signed-in
// admin could already do by hand in this screen — the assistant never
// gets a capability the UI itself doesn't already expose. Nothing here
// is destructive/irreversible without the admin seeing it happen
// on-screen; a broadcast is only ever *drafted*, never sent, without a
// separate manual tap on "Bhejo".
export type AdminAssistantAction =
  | { type: "send_message"; text: string }
  | { type: "toggle_ai_mode"; enabled: boolean }
  | { type: "set_status"; status: ConversationStatus }
  | { type: "set_tags"; tags: string[] }
  | { type: "filter_status"; status: "all" | ConversationStatus }
  | { type: "select_conversation"; query: string }
  | { type: "prepare_broadcast"; text: string; tag?: string }
  // Places a real voice/video call the same way tapping the phone/video
  // icon in ChatWindow's header would — "query" (name/number) is
  // optional: omit it to call whoever's currently selected.
  | { type: "start_call"; kind: "voice" | "video"; query?: string }
  // Shares the ADMIN's current device location into the selected
  // conversation — same as tapping the pin icon in ChatWindow. Uses
  // navigator.geolocation, so it always needs the admin's own browser
  // permission grant; nothing here can silently read location without
  // that OS/browser prompt.
  | { type: "send_location" };

export async function callAdminAssistant(
  systemPrompt: string,
  history: ChatTurn[],
  userText: string
): Promise<string> {
  const token = await getAccessToken();
  if (!token) {
    const err: any = new Error("Not signed in");
    err.status = 401;
    throw err;
  }

  // Only the most recent turns — keeps the prompt bounded and avoids the
  // model losing track / repeating itself in long-running sessions.
  const recentHistory = history.slice(-16);
  const apiMessages = [
    ...recentHistory.map((m) => ({ role: m.role === "bot" ? "assistant" : "user", content: m.text })),
    { role: "user", content: userText },
  ];

  const response = await fetch("/api/admin-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ systemPrompt, messages: apiMessages }),
  });

  if (!response.ok) {
    let detail: any = null;
    try { detail = await response.json(); } catch { /* body wasn't JSON */ }
    const err: any = new Error(`API error ${response.status}`);
    err.status = response.status;
    err.detail = detail;
    throw err;
  }
  const data = await response.json();
  const text = (data.content || [])
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
  return text || "Mujhe iska koi acha jawab nahi mil raha — dobara try karein?";
}

export function parseAssistantReply(raw: string): { reply: string; action: AdminAssistantAction | null } {
  let cleaned = (raw || "").trim();
  cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const jsonSlice = cleaned.slice(start, end + 1);
    try {
      const parsed = JSON.parse(jsonSlice);
      if (parsed && typeof parsed === "object" && "reply" in parsed) {
        return { reply: parsed.reply, action: parsed.action || null };
      }
    } catch {
      // fall through to plain text
    }
  }
  return { reply: raw, action: null };
}

export function TypingDots() {
  return React.createElement(
    "div",
    { className: "flex items-center gap-1 px-4 py-3 bg-app border rounded-2xl rounded-bl-md w-fit" },
    React.createElement(Loader2, { size: 13, className: "animate-spin text-brand" }),
    React.createElement("span", { className: "text-xs text-muted" }, "Thinking…")
  );
}
