// ============================================================
//  src/components/CannedResponsesPicker.tsx
//  Phase 8 — Quick Wins: canned responses / quick replies
//  Shared, shop-wide list of pre-saved replies for staff. Tapping one
//  fills the message input (doesn't send automatically) so the staff
//  member can still tweak it before hitting Send. Staff can also add
//  or remove entries from here — the list is shared across everyone
//  with 'owner'/'agent' role.
// ============================================================

import React, { useEffect, useState } from "react";
import { X, Zap, Plus, Trash2, Loader2 } from "lucide-react";
import { CannedResponse } from "../lib/types";
import { listCannedResponses, createCannedResponse, deleteCannedResponse } from "../lib/chatApi";

interface CannedResponsesPickerProps {
  myUserId: string;
  onPick: (body: string) => void;
  onClose: () => void;
}

export default function CannedResponsesPicker({ myUserId, onPick, onClose }: CannedResponsesPickerProps) {
  const [items, setItems] = useState<CannedResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const data = await listCannedResponses();
    setItems(data);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handleAdd = async () => {
    const title = newTitle.trim();
    const body = newBody.trim();
    if (!title || !body) return;
    setSaving(true);
    const ok = await createCannedResponse(myUserId, title, body);
    setSaving(false);
    if (ok) {
      setNewTitle("");
      setNewBody("");
      setShowAddForm(false);
      load();
    }
  };

  const handleDelete = async (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    await deleteCannedResponse(id);
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col" style={{ backgroundColor: "var(--color-bg)" }}>
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <Zap size={15} className="text-brand shrink-0" />
        <span className="flex-1 text-sm font-semibold text-fg">Quick replies</span>
        <button
          onClick={() => setShowAddForm((v) => !v)}
          className="w-7 h-7 rounded-full flex items-center justify-center text-muted hover:bg-fg/5"
          title="Add new quick reply"
        >
          <Plus size={16} />
        </button>
        <button onClick={onClose} className="text-muted hover:text-fg shrink-0">
          <X size={18} />
        </button>
      </div>

      {showAddForm && (
        <div className="p-3 border-b space-y-2 bg-surface/50">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Short title (e.g. Delivery time)"
            className="w-full px-3 py-2 rounded-lg bg-app border text-sm text-fg focus:outline-none focus:ring-2 focus:ring-brand/50"
          />
          <textarea
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            rows={3}
            placeholder="Reply text…"
            className="w-full px-3 py-2 rounded-lg bg-app border text-sm text-fg resize-none focus:outline-none focus:ring-2 focus:ring-brand/50"
          />
          <button
            onClick={handleAdd}
            disabled={!newTitle.trim() || !newBody.trim() || saving}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-brand text-white text-xs font-semibold disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            {saving ? "Saving…" : "Save quick reply"}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-4 py-8 text-center text-xs text-muted">Load ho raha hai…</div>
        ) : items.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted">
            Abhi koi quick reply nahi hai — "+" se ek banao.
          </div>
        ) : (
          items.map((item) => (
            <div key={item.id} className="w-full flex items-center gap-2 px-4 py-3 border-b hover:bg-fg/5">
              <button onClick={() => onPick(item.body)} className="flex-1 min-w-0 text-left">
                <div className="text-xs font-semibold truncate text-fg">{item.title}</div>
                <div className="text-[11px] text-muted truncate">{item.body}</div>
              </button>
              <button
                onClick={() => handleDelete(item.id)}
                className="w-7 h-7 rounded-full flex items-center justify-center text-muted hover:bg-danger/10 hover:text-danger shrink-0"
                title="Delete"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
