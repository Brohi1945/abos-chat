// ============================================================
//  src/components/ThemeSwitcher.tsx
//  ONE button — tap opens a small popover with Light / Dark /
//  Colorful. Used to render as 3 separate icons always visible,
//  which (along with Staff + Broadcast + Exit all inline too)
//  crowded the header on narrow screens and pushed the email text
//  into an overflow/wrap. This is the single-button version.
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import { Sun, Moon, Sparkles, Check } from "lucide-react";
import { useTheme, ThemeMode } from "../theme";

const OPTIONS: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon },
  { mode: "colorful", label: "Colorful", icon: Sparkles },
];

export default function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { mode, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ActiveIcon = OPTIONS.find((o) => o.mode === mode)?.icon || Sun;

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Theme badlo"
        aria-label="Theme"
        aria-expanded={open}
        className={`flex items-center justify-center rounded-full text-muted hover:bg-fg/5 shrink-0 ${
          compact ? "w-8 h-8" : "w-9 h-9"
        } ${open ? "bg-fg/10" : ""}`}
      >
        <ActiveIcon size={compact ? 14 : 15} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 bg-surface border rounded-xl shadow-lg py-1 min-w-[140px]">
          {OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = mode === opt.mode;
            return (
              <button
                key={opt.mode}
                type="button"
                onClick={() => {
                  setTheme(opt.mode);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left ${
                  active ? "text-brand font-semibold" : "text-fg hover:bg-fg/5"
                }`}
              >
                <Icon size={14} className="shrink-0" />
                <span className="flex-1">{opt.label}</span>
                {active && <Check size={13} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
