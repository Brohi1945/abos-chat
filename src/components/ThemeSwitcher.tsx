import React from "react";
import { Sun, Moon, Sparkles } from "lucide-react";
import { useTheme, ThemeMode } from "../theme";

// Shared by both the customer chat screen and the owner inbox — either
// side can pick Light / Dark / Colorful. Stored per-device (see
// ThemeProvider), so each person's choice is their own.
const OPTIONS: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon },
  { mode: "colorful", label: "Colorful", icon: Sparkles },
];

export default function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { mode, setTheme } = useTheme();

  return (
    <div
      className="flex items-center gap-0.5 bg-surface border rounded-full p-0.5 shrink-0"
      role="group"
      aria-label="Theme"
    >
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const active = mode === opt.mode;
        return (
          <button
            key={opt.mode}
            type="button"
            onClick={() => setTheme(opt.mode)}
            title={`${opt.label} theme`}
            aria-pressed={active}
            className={`flex items-center justify-center rounded-full transition ${
              compact ? "w-7 h-7" : "w-8 h-8"
            } ${active ? "bg-brand text-white" : "text-muted hover:bg-fg/5"}`}
          >
            <Icon size={compact ? 13 : 14} />
          </button>
        );
      })}
    </div>
  );
}
