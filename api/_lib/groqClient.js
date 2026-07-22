// Shared Groq (OpenAI-compatible) caller — now supports tool-calling
// so the AI can act (add items to an order, confirm it, escalate to a
// human) instead of only generating plain text.

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(attempt, response) {
  const retryAfterHeader = response?.headers?.get?.("retry-after");
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  const jitter = Math.random() * 250;
  return BASE_DELAY_MS * 2 ** attempt + jitter;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls Groq's chat-completions endpoint with the full message history
 * (including any prior tool calls/results) and an optional list of
 * tools. Returns the raw assistant message object — {content,
 * tool_calls} — NOT just text, so the caller can run a tool loop.
 */
export async function callGroqAgent(messages, tools) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const err = new Error("GROQ_API_KEY is not set in Vercel environment variables");
    err.status = 500;
    throw err;
  }

  const body = JSON.stringify({
    model: "openai/gpt-oss-120b",
    messages,
    temperature: 0.4,
    max_completion_tokens: 700,
    ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
  });

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
      });
    } catch (networkErr) {
      lastErr = networkErr;
      if (attempt < MAX_RETRIES) {
        await sleep(computeDelay(attempt));
        continue;
      }
      const err = new Error("Could not reach Groq (network error or timeout)");
      err.status = 502;
      throw err;
    }

    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      lastErr = { status: response.status };
      await sleep(computeDelay(attempt, response));
      continue;
    }

    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const err = new Error(response.status === 429 ? "Groq rate limit hit" : "Groq API error");
      err.status = response.status;
      err.data = data;
      throw err;
    }

    return data?.choices?.[0]?.message || null;
  }

  const err = new Error("Groq API error after retries");
  err.status = lastErr?.status || 502;
  throw err;
}
