import React, { useEffect, useState } from "react";
import { Package2, ChevronDown, ChevronUp } from "lucide-react";
import { getLinkedOrders } from "../lib/chatApi";
import { LinkedOrder } from "../lib/types";

interface OrderContextPanelProps {
  conversationId: string;
}

export default function OrderContextPanel({ conversationId }: OrderContextPanelProps) {
  const [orders, setOrders] = useState<LinkedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setExpanded(false);
    getLinkedOrders(conversationId).then((data) => {
      if (!cancelled) {
        setOrders(data);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  if (loading || orders.length === 0) return null;

  return (
    <div className="border-b border-slate-800 bg-slate-900/30">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-4 py-2 flex items-center justify-between text-xs text-slate-400 hover:text-slate-200"
      >
        <span className="flex items-center gap-1.5">
          <Package2 size={13} />
          {orders.length} matched order{orders.length > 1 ? "s" : ""} (by email)
        </span>
        {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {expanded && (
        <div className="px-4 pb-3 space-y-2 max-h-40 overflow-y-auto">
          {orders.map((o) => (
            <div key={o.id} className="text-xs bg-slate-900/60 rounded-lg px-3 py-2">
              <div className="flex items-center justify-between font-semibold">
                <span>#{o.id}</span>
                <span className="text-brand">Rs {o.total}</span>
              </div>
              <div className="text-slate-500 mt-0.5">
                {o.status || "—"} · {o.payment_status || "—"} · {o.date || ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
