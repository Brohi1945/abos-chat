// Backend (Vercel function) Sentry error capture — this half never
// existed before Phase 4.6 (src/lib/sentry.ts already covered the
// frontend; api/ had zero error monitoring). Deliberately tiny: just
// captureException, no tracing/performance overhead, since serverless
// functions are short-lived and full APM here isn't worth it.
//
// A voice pipeline (STT/TTS/LiveKit dispatch) has a lot more ways to
// silently fail than a text reply, so wiring this into the new
// api/ai-call-*.js endpoints from day one (Phase 4.6a) — instead of
// only console.error like the older endpoints — is deliberate.
import * as Sentry from "@sentry/node";

let initialized = false;

function ensureInit() {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN || process.env.VITE_SENTRY_DSN;
  if (dsn) {
    Sentry.init({
      dsn,
      environment: process.env.VERCEL_ENV || "development",
      tracesSampleRate: 0,
    });
  }
  initialized = true;
}

/** No-ops safely if no SENTRY_DSN is configured — never throws. */
export function captureServerError(source, error, extra) {
  try {
    ensureInit();
    if (!process.env.SENTRY_DSN && !process.env.VITE_SENTRY_DSN) return;
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
      tags: { source },
      extra,
    });
  } catch {
    // Sentry itself must never be the reason a request fails.
  }
}
