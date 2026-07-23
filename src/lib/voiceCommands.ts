// ============================================================
//  voiceCommands — detects two kinds of spoken/typed UI commands
//  that the admin AI assistant should handle locally instead of
//  sending to the LLM (the model has no way to actually flip our
//  speaker toggle or CSS theme classes — it used to just apologize
//  in text when asked):
//
//  1. Voice toggle ("voice mein baat karo", "chup ho jao")
//  2. Theme switch ("dark mode laga do", "colorful theme kar do",
//     "light theme on karo")
// ============================================================
import type { ThemeMode } from "../theme";

const ENABLE_PATTERNS: RegExp[] = [
  /\bvoice\s*(mein|main)?\s*baat\b/i,
  /\bvoice\s*on\b/i,
  /\bvoice\s*se\s*bol/i,
  /\bawaaz\s*(mein|main)?\s*bol/i,
  /\bawaaz\s*on\b/i,
  /\bbol\s*kar\s*jawab/i,
  /\bbol\s*kar\s*baat/i,
  /\bbol\s*kar\s*bolo\b/i,
];

const DISABLE_PATTERNS: RegExp[] = [
  /\bvoice\s*off\b/i,
  /\bawaaz\s*off\b/i,
  /\bchup\s*ho\s*ja/i,
  /\bbolna\s*band\b/i,
  /\bvoice\s*band\s*karo\b/i,
  /\bmute\s*(kar|ho)/i,
];

export function detectVoiceToggleCommand(text: string): "enable" | "disable" | null {
  const t = text.trim();
  if (!t) return null;
  // check disable first — "voice band karo" would otherwise partially
  // match an enable-ish pattern in some phrasings
  if (DISABLE_PATTERNS.some((p) => p.test(t))) return "disable";
  if (ENABLE_PATTERNS.some((p) => p.test(t))) return "enable";
  return null;
}

// ---- Theme switch ("dark mode laga do", "colorful theme kar do") ----

const THEME_KEYWORDS: Record<ThemeMode, RegExp[]> = {
  colorful: [
    /\bcolou?rful\s*(theme|mode)?\b/i,
    /\brangeen\s*(theme|mode)?\b/i,
    /\bvibrant\s*(theme|mode)?\b/i,
    /\baurora\s*(theme|mode)?\b/i,
    /\bmulti\s*color\s*(theme|mode)?\b/i,
  ],
  dark: [
    /\bdark\s*(mode|theme)\b/i,
    /\btheme\s*dark\s*(kar|laga|banao)/i,
    /\bkaala?\s*theme\b/i,
    /\bandheri?\s*theme\b/i,
  ],
  light: [
    /\blight\s*(mode|theme)\b/i,
    /\btheme\s*light\s*(kar|laga|banao)/i,
    /\bwhite\s*theme\b/i,
    /\broshan\s*theme\b/i,
  ],
};

const THEME_ORDER: ThemeMode[] = ["colorful", "dark", "light"];

export function detectThemeCommand(text: string): ThemeMode | null {
  const t = text.trim();
  if (!t) return null;
  for (const mode of THEME_ORDER) {
    if (THEME_KEYWORDS[mode].some((p) => p.test(t))) return mode;
  }
  return null;
}
