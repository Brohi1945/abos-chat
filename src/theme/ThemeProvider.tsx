import React, { createContext, useContext, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "colorful";

const THEME_MODES: ThemeMode[] = ["light", "dark", "colorful"];

interface ThemeContextValue {
  mode: ThemeMode;
  /** Cycle light → dark → colorful → light. Used by the manual switcher. */
  cycleTheme: () => void;
  /** Set an exact theme directly — used by the theme switcher UI and by
   *  the admin AI assistant (voice + typed commands). */
  setTheme: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

// Local to this device/browser — both the customer app and the owner
// inbox read/write the same key, so switching it in one screen doesn't
// silently reset when navigating to the other (both live in the same
// app shell here, but this keeps the behavior correct regardless).
const STORAGE_KEY = "abos-chat-theme";

function isThemeMode(v: unknown): v is ThemeMode {
  return v === "light" || v === "dark" || v === "colorful";
}

function getInitialMode(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (isThemeMode(saved)) return saved;
  // First visit: respect system preference, default to dark otherwise
  // (matches the app's original look).
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  return prefersLight ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(getInitialMode);

  useEffect(() => {
    const root = document.documentElement;
    // Only ever touch our own theme classes, never anything else that
    // might be set on <html>.
    root.classList.remove("dark", "colorful");
    if (mode === "dark" || mode === "colorful") root.classList.add(mode);
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  // Keep multiple tabs/windows of the same account in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && isThemeMode(e.newValue)) setMode(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setTheme = (m: ThemeMode) => {
    if (isThemeMode(m)) setMode(m);
  };

  const cycleTheme = () => {
    setMode((m) => {
      const idx = THEME_MODES.indexOf(m);
      return THEME_MODES[(idx + 1) % THEME_MODES.length];
    });
  };

  return (
    <ThemeContext.Provider value={{ mode, cycleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
