import React, { useEffect, useState } from "react";
import { X, Search, Package } from "lucide-react";
import { searchProducts } from "../lib/chatApi";
import { ProductSnapshot } from "../lib/types";

interface ProductPickerProps {
  onPick: (product: ProductSnapshot) => void;
  onClose: () => void;
}

export default function ProductPicker({ onPick, onClose }: ProductPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSnapshot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      const data = await searchProducts(query);
      if (!cancelled) {
        setResults(data);
        setLoading(false);
      }
    }, 250); // small debounce so we don't query on every keystroke
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  return (
    <div className="absolute inset-0 z-10 bg-app/95 flex flex-col">
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <Search size={15} className="text-muted shrink-0" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Product search karo…"
          className="flex-1 bg-transparent text-sm text-fg focus:outline-none"
        />
        <button onClick={onClose} className="text-muted hover:text-fg shrink-0">
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-4 py-8 text-center text-xs text-muted">Load ho raha hai…</div>
        ) : results.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted">Koi product nahi mila.</div>
        ) : (
          results.map((p) => (
            <button
              key={p.id}
              onClick={() => onPick(p)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left border-b hover:bg-fg/5"
            >
              <div className="w-9 h-9 rounded-lg bg-brand/20 text-brand flex items-center justify-center shrink-0">
                <Package size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold truncate">{p.name}</div>
                <div className="text-[10px] text-muted truncate">
                  Rs {p.price} · {p.stock > 0 ? `${p.stock} in stock` : "Out of stock"}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
