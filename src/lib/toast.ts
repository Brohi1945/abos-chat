import toast from "react-hot-toast";
import type { CSSProperties } from "react";

// Colors here intentionally read from the same CSS variables as the
// rest of the theme system, so toasts match whichever of the 3 themes
// (light / dark / colorful) is currently active instead of being
// hardcoded to one look.
const baseStyle: CSSProperties = {
  background: "var(--color-surface)",
  color: "var(--color-text)",
  border: "1px solid var(--color-border)",
  borderRadius: "12px",
  fontSize: "13px",
  fontWeight: 500,
  padding: "10px 14px",
};

const DURATION = { success: 3000, error: 4500, info: 3500 };

export function toastSuccess(message: string): void {
  toast.success(message, {
    duration: DURATION.success,
    style: baseStyle,
    iconTheme: { primary: "var(--color-success)", secondary: "var(--color-surface)" },
  });
}

export function toastError(message: string): void {
  toast.error(message, {
    duration: DURATION.error,
    style: baseStyle,
    iconTheme: { primary: "var(--color-danger)", secondary: "var(--color-surface)" },
  });
}

export function toastInfo(message: string): void {
  toast(message, {
    duration: DURATION.info,
    style: baseStyle,
    icon: "ℹ️",
  });
}
