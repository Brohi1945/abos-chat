// ============================================================
//  GET /api/turn-credentials
//  Fetches time-limited TURN credentials from metered.ca
//  Called by the browser before starting a call.
//  PHASE 1 + PHASE 4: Dynamic credentials with expiry
// ============================================================

export const config = {
  maxDuration: 5,
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const baseUrl = process.env.METERED_BASE_URL;
    const apiKey = process.env.METERED_API_KEY;

    if (!baseUrl || !apiKey) {
      console.error("Missing METERED_BASE_URL or METERED_API_KEY");
      return res.status(500).json({
        error: "TURN service not configured. Set METERED_BASE_URL and METERED_API_KEY in Vercel environment variables.",
      });
    }

    // Default expiry: 24 hours (86400 seconds)
    const expiryInSeconds = parseInt(req.query.expiry) || 86400;

    const response = await fetch(`${baseUrl}/api/v1/turn/credential`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expiryInSeconds: expiryInSeconds,
        label: `abos-chat-${Date.now()}`,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Metered API error:", response.status, errorText);
      return res.status(response.status).json({
        error: "Failed to fetch TURN credentials from metered.ca",
        details: errorText,
      });
    }

    const data = await response.json();

    return res.status(200).json({
      iceServers: [
        {
          urls: data.urls || "turn:global.turn.metered.ca:443?transport=tcp",
          username: data.username,
          credential: data.credential,
        },
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });
  } catch (err) {
    console.error("TURN credentials error:", err);
    return res.status(500).json({
      error: "Internal server error",
      message: err.message,
    });
  }
}
