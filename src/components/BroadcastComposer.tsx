import React, { useState } from "react";
import { X, Send, Loader2, Megaphone } from "lucide-react";
import { Profile } from "../lib/types";
import { sendBroadcast } from "../lib/chatApi";

interface BroadcastComposerProps {
  me: Profile;
  knownTags: string[];
  onClose: () => void;
  onSent: () => void;
  // Lets the admin AI assistant hand off a drafted broadcast — it only
  // ever pre-fills the form, the human still has to tap "Bhejo" to
  // actually send it to customers.
  initialBody?: string;
  initialTag?: string;
}

export default function BroadcastComposer({ me, knownTags, onClose, onSent, initialBody, initialTag }: BroadcastComposerProps) {
  const [body, setBody] = useState(initialBody || "");
  const [targetTag, setTargetTag] = useState<string>(initialTag || "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const handleSend = async () => {
    const text = body.trim();
    if (!text) return;
    setSending(true);
    setError("");
    const ok = await sendBroadcast(me, text, targetTag || undefined);
    setSending(false);
    if (!ok) {
      setError("Bhejne mein masla hua — dobara try karo.");
      return;
    }
    onSent();
  };

  return (
    <div className="fixed inset-0 bg-fg/40 z-50 flex items-end sm:items-center justify-center">
      <div className="bg-surface border rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] overflow-y-auto">
        <div className="px-4 py-3 border-b flex items-center justify-between sticky top-0 bg-surface">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Megaphone size={16} className="text-brand" />
            Broadcast message
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:bg-fg/5">
            <X size={16} />
          </button>
        </div>

        {initialBody && (
          <div className="mx-4 mt-3 text-[11px] text-brand bg-brand/10 rounded-lg px-3 py-2">
            AI assistant ne yeh draft tayyar kiya hai — bhejne se pehle check kar lein.
          </div>
        )}

        <div className="p-4 space-y-3">
          <div>
            <label className="text-[11px] text-muted mb-1 block">Kis ko bhejna hai</label>
            <select
              value={targetTag}
              onChange={(e) => setTargetTag(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-app border text-sm text-fg focus:outline-none focus:ring-2 focus:ring-brand/50"
            >
              <option value="">Sab customers</option>
              {knownTags.map((t) => (
                <option key={t} value={t}>
                  Tag: {t}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] text-muted mb-1 block">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Broadcast message likho…"
              className="w-full px-3 py-2.5 rounded-lg bg-app border text-sm text-fg resize-none focus:outline-none focus:ring-2 focus:ring-brand/50"
            />
          </div>

          {error && <div className="text-xs text-danger">{error}</div>}

          <button
            onClick={handleSend}
            disabled={!body.trim() || sending}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-brand text-white text-sm font-semibold disabled:opacity-40"
          >
            {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            {sending ? "Bhej raha hai…" : "Bhejo"}
          </button>
        </div>
      </div>
    </div>
  );
}
