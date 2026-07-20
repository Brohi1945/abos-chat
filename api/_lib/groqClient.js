// Shared Groq (OpenAI-compatible) caller for the AI auto-reply feature.
// Adapted from ABOS's api/_lib/groqClient.js — same retry/backoff
// behavior, but returns plain text (a chat reply) instead of a
// JSON action payload, since this bot only replies, it doesn't
// control UI state.

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

export async function callGroqChat(systemPrompt, historyMessages) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const err = new Error("GROQ_API_KEY is not set in Vercel environment variables");
    err.status = 500;
    throw err;
  }

  const chatMessages = [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(historyMessages) ? historyMessages : []),
  ];

  const body = JSON.stringify({
    model: "openai/gpt-oss-120b",
    messages: chatMessages,
    temperature: 0.6,
    max_completion_tokens: 400,
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

    return (data?.choices?.[0]?.message?.content || "").trim();
  }

  const err = new Error("Groq API error after retries");
  err.status = lastErr?.status || 502;
  throw err;
}
