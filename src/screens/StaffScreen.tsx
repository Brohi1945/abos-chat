// ============================================================
//  src/screens/StaffScreen.tsx
//  Phase 9 Feature 1 — Staff accounts + roles.
//  Owner-only screen: promote a customer to agent, demote back,
//  deactivate/reactivate a staff account. Rendered as a full-screen
//  overlay from OwnerInboxScreen (same visual pattern as
//  BroadcastComposer), gated behind the strict isOwner prop there —
//  an agent should never be able to open this even by guessing a URL,
//  since the underlying RPCs also re-check abos_chat_is_admin() server
//  side regardless of what the UI shows.
// ============================================================

import React, { useEffect, useState } from "react";
import { X, Users, Shield, UserMinus, UserPlus, Loader2 } from "lucide-react";
import { Profile } from "../lib/types";
import { listAllProfiles, setStaffRole, setStaffActive } from "../lib/chatApi";
import { toastError, toastSuccess } from "../lib/toast";

interface StaffScreenProps {
  me: Profile;
  onClose: () => void;
}

export default function StaffScreen({ me, onClose }: StaffScreenProps) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setProfiles(await listAllProfiles());
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handlePromote = async (p: Profile) => {
    setBusyId(p.id);
    const ok = await setStaffRole(p.id, "agent");
    setBusyId(null);
    if (!ok) {
      toastError("Promote nahi ho saka.");
      return;
    }
    toastSuccess(`${p.name || p.email || "User"} ab agent hai.`);
    load();
  };

  const handleDemote = async (p: Profile) => {
    if (!window.confirm(`${p.name || p.email || "Yeh user"} ko customer bana dein?`)) return;
    setBusyId(p.id);
    const ok = await setStaffRole(p.id, "customer");
    setBusyId(null);
    if (!ok) {
      toastError("Demote nahi ho saka.");
      return;
    }
    toastSuccess("Role update ho gaya.");
    load();
  };

  const handleToggleActive = async (p: Profile) => {
    const next = !p.active;
    if (!next && !window.confirm(`${p.name || p.email || "Yeh staff"} ko deactivate kar dein? Wo turant access khoye ga.`)) return;
    setBusyId(p.id);
    const ok = await setStaffActive(p.id, next);
    setBusyId(null);
    if (!ok) {
      toastError("Update nahi ho saka.");
      return;
    }
    load();
  };

  const owners = profiles.filter((p) => p.role === "owner");
  const agents = profiles.filter((p) => p.role === "agent");
  const customers = profiles.filter((p) => p.role === "customer");

  return (
    <div className="fixed inset-0 bg-fg/40 z-50 flex items-end sm:items-center justify-center">
      <div className="bg-surface border rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="px-4 py-3 border-b flex items-center justify-between sticky top-0 bg-surface">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Users size={16} className="text-brand" />
            Staff
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:bg-fg/5">
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="p-8 flex justify-center">
            <Loader2 className="animate-spin text-muted" size={20} />
          </div>
        ) : (
          <div className="p-4 space-y-5">
            {/* Owners — informational only, role changes not offered here */}
            <div>
              <div className="text-[11px] font-semibold text-muted uppercase mb-2 flex items-center gap-1.5">
                <Shield size={12} /> Owner
              </div>
              {owners.map((p) => (
                <div key={p.id} className="flex items-center gap-2.5 py-2">
                  <div className="w-8 h-8 rounded-full bg-brand/20 text-brand flex items-center justify-center text-xs font-bold shrink-0">
                    {(p.name || p.email || "?")[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-fg truncate">
                      {p.name || p.email} {p.id === me.id && <span className="text-muted">(aap)</span>}
                    </div>
                    <div className="text-[10px] text-muted truncate">{p.email}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Agents — can be demoted or deactivated */}
            <div>
              <div className="text-[11px] font-semibold text-muted uppercase mb-2">
                Agents ({agents.length})
              </div>
              {agents.length === 0 && <div className="text-xs text-muted py-2">Koi agent nahi hai abhi.</div>}
              {agents.map((p) => (
                <div key={p.id} className="flex items-center gap-2.5 py-2">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                      p.active ? "bg-brand/20 text-brand" : "bg-fg/10 text-muted"
                    }`}
                  >
                    {(p.name || p.email || "?")[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-fg truncate flex items-center gap-1.5">
                      {p.name || p.email}
                      {!p.active && (
                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-danger/15 text-danger">
                          Deactivated
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-muted truncate">{p.email}</div>
                  </div>
                  <button
                    disabled={busyId === p.id}
                    onClick={() => handleToggleActive(p)}
                    className="text-[11px] font-semibold px-2.5 py-1.5 rounded-full bg-fg/5 hover:bg-fg/10 text-fg shrink-0 disabled:opacity-50"
                  >
                    {p.active ? "Deactivate" : "Reactivate"}
                  </button>
                  <button
                    disabled={busyId === p.id}
                    onClick={() => handleDemote(p)}
                    title="Customer bana do"
                    className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:bg-fg/5 shrink-0 disabled:opacity-50"
                  >
                    <UserMinus size={15} />
                  </button>
                </div>
              ))}
            </div>

            {/* Customers — can be promoted to agent */}
            <div>
              <div className="text-[11px] font-semibold text-muted uppercase mb-2">
                Customers ({customers.length})
              </div>
              <div className="text-[11px] text-muted mb-2">
                Kisi customer ko agent banane ke liye unke naam ke saamne "Agent banao" dabao.
              </div>
              {customers.map((p) => (
                <div key={p.id} className="flex items-center gap-2.5 py-2">
                  <div className="w-8 h-8 rounded-full bg-fg/10 text-muted flex items-center justify-center text-xs font-bold shrink-0">
                    {(p.name || p.email || "?")[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-fg truncate">{p.name || p.email || p.customer_number}</div>
                    <div className="text-[10px] text-muted truncate">{p.email || p.customer_number}</div>
                  </div>
                  <button
                    disabled={busyId === p.id}
                    onClick={() => handlePromote(p)}
                    className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded-full bg-brand/10 hover:bg-brand/20 text-brand shrink-0 disabled:opacity-50"
                  >
                    <UserPlus size={13} /> Agent banao
                  </button>
                </div>
              ))}
              {customers.length === 0 && <div className="text-xs text-muted py-2">Koi customer nahi hai abhi.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
