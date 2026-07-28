// ============================================================
//  src/components/DebugErrorBoundary.tsx
//  TEMPORARY diagnostic file — two tools in one:
//
//  1) DebugErrorBoundary (default export) — unchanged, section-level.
//     Used inside ChatWindow.tsx around the overlays and message list.
//     Catches React render errors in that one section only, and
//     REPLACES that section with a red error box.
//
//  2) GlobalErrorCatcher (named export) — NEW, app-wide. Mount this
//     once at the very top of the app (src/main.tsx, wrapping <App/>)
//     to catch literally everything else a section boundary can't:
//       - render errors anywhere else in the tree
//       - errors thrown inside onClick/onChange/etc. handlers
//       - errors thrown inside async functions (await ...) 
//       - unhandled promise rejections
//     These last three are exactly the kind of error that button
//     clicks (reactions, pin, delete, search, ABI, etc.) would throw,
//     and a normal React error boundary CANNOT catch them — this is
//     the gap the section-level boundary alone was missing.
//     Shows a floating red banner on top of the app (doesn't unmount
//     anything, so the broken UI stays visible for context) instead
//     of failing silently.
//
//  Safe to delete both, and their wiring in ChatWindow.tsx / main.tsx,
//  once the real bug is found and fixed.
// ============================================================

import React from "react";
import { captureError } from "../lib/sentry";

interface Props {
  label: string;
  children: React.ReactNode;
}
interface State {
  error: Error | null;
}

export default class DebugErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Also log it, in case DevTools console is reachable.
    console.error(`[DebugErrorBoundary:${this.props.label}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: "12px",
            margin: "8px",
            background: "#fee2e2",
            border: "1px solid #ef4444",
            borderRadius: "8px",
            color: "#7f1d1d",
            fontSize: "12px",
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            zIndex: 9999,
            position: "relative",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            ⚠️ Error in "{this.props.label}" — iska screenshot Claude ko bhejo:
          </div>
          {this.state.error.message}
          {"\n\n"}
          {this.state.error.stack?.slice(0, 500)}
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================
//  GlobalErrorCatcher — mount once at the top of the app.
// ============================================================
interface CaughtError {
  source: string;
  message: string;
  stack?: string;
}
interface GlobalState {
  errors: CaughtError[];
}

export class GlobalErrorCatcher extends React.Component<{ children: React.ReactNode }, GlobalState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { errors: [] };
  }

  // Render-phase errors anywhere in the tree below this.
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.pushError("React render", error.message, (error.stack || "") + "\n" + info.componentStack);
  }

  // Errors thrown inside onClick/onChange/etc. handlers, and any
  // other synchronous runtime error outside React's render cycle.
  handleWindowError = (e: ErrorEvent) => {
    this.pushError("Click handler / runtime", e.message, e.error?.stack);
  };

  // Errors thrown inside async functions (await ...), and any
  // promise that rejects without a .catch() — this is where most of
  // the Phase 8 handlers (toggleReaction, pinMessage, deleteMessage,
  // searchMessagesInConversation, etc.) would surface a bug, since
  // they're all async.
  handleRejection = (e: PromiseRejectionEvent) => {
    const reason: any = e.reason;
    this.pushError("Unhandled promise rejection", reason?.message || String(reason), reason?.stack);
  };

  componentDidMount() {
    window.addEventListener("error", this.handleWindowError);
    window.addEventListener("unhandledrejection", this.handleRejection);
  }

  componentWillUnmount() {
    window.removeEventListener("error", this.handleWindowError);
    window.removeEventListener("unhandledrejection", this.handleRejection);
  }

  pushError(source: string, message: string, stack?: string) {
    console.error(`[GlobalErrorCatcher:${source}]`, message, stack);
    const err = new Error(message);
    if (stack) err.stack = stack;
    captureError(source, err);
    this.setState((s) => ({
      errors: [...s.errors, { source, message, stack }].slice(-5), // keep last 5 only
    }));
  }

  dismiss(i: number) {
    this.setState((s) => ({ errors: s.errors.filter((_, idx) => idx !== i) }));
  }

  render() {
    return (
      <>
        {this.props.children}
        {this.state.errors.length > 0 && (
          <div
            style={{
              position: "fixed",
              left: 8,
              right: 8,
              bottom: 8,
              zIndex: 999999,
              maxHeight: "50vh",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              pointerEvents: "none",
            }}
          >
            {this.state.errors.map((err, i) => (
              <div
                key={i}
                style={{
                  padding: "10px 12px",
                  background: "#fee2e2",
                  border: "1px solid #ef4444",
                  borderRadius: "8px",
                  color: "#7f1d1d",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
                  pointerEvents: "auto",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontWeight: 700 }}>⚠️ [{err.source}] — screenshot bhejo:</div>
                  <button
                    onClick={() => this.dismiss(i)}
                    style={{ background: "none", border: "none", color: "#7f1d1d", fontWeight: 700, cursor: "pointer", fontSize: "13px" }}
                  >
                    ✕
                  </button>
                </div>
                <div style={{ marginTop: 4 }}>{err.message}</div>
                {err.stack && <div style={{ marginTop: 4, opacity: 0.75 }}>{err.stack.slice(0, 400)}</div>}
              </div>
            ))}
          </div>
        )}
      </>
    );
  }
}

