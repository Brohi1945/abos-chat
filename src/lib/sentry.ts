// ============================================================
//  src/lib/sentry.ts
//  Sentry error monitoring for ABOS Chat.
//
//  Called once from main.tsx before the app renders. Safe to run in
//  local dev too — if VITE_SENTRY_DSN isn't set (e.g. no .env.local
//  on a dev machine), init() just no-ops instead of throwing, so this
//  never blocks `npm run dev`.
//
//  DSN itself is not a secret (it's a write-only ingest endpoint, safe
//  to ship in the client bundle) — but it still lives in an env var so
//  it's easy to swap per-environment (e.g. a separate DSN later if a
//  staging project is ever added) without touching code.
// ============================================================

import * as Sentry from "@sentry/react";

export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) {
    console.warn("[sentry] VITE_SENTRY_DSN not set — error monitoring disabled.");
    return;
  }

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE, // "development" locally, "production" on Vercel
    // Low sample rate — this app doesn't need full performance tracing,
    // just error capture. Keeps the free-tier quota mostly for errors.
    tracesSampleRate: 0.1,
    integrations: [Sentry.browserTracingIntegration()],
  });
}

/**
 * Attach the user's ABOS Chat profile id/role to every error reported
 * after this point, so an issue in the Sentry dashboard shows *who* hit
 * it and whether they're staff or a customer — call this right after
 * the profile loads (AuthGate / App.tsx), not before.
 */
export function setSentryUser(id: string, role: string) {
  Sentry.setUser({ id, role });
}

export function captureError(source: string, error: unknown, extra?: Record<string, unknown>) {
  Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
    tags: { source },
    extra,
  });
}
