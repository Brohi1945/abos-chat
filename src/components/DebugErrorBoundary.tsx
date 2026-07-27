// ============================================================
//  src/components/DebugErrorBoundary.tsx
//  TEMPORARY diagnostic component.
//  If something inside it throws during render, instead of the
//  screen silently doing nothing, this shows a red box with the
//  exact error — screenshot that box and send it back so the
//  real fix can be pinpointed. Safe to delete once the bug that
//  is being hunted (Quick Wins / ABI) is found and fixed.
// ============================================================

import React from "react";

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
