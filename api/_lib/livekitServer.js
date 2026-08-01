// Phase 4.6: shared LiveKit server-side helper.
//
// Everything here uses the LiveKit *server* SDK (API key + secret,
// never shipped to the browser) to: mint short-lived join tokens for
// the customer's browser, create/ensure the per-call room, and
// explicitly dispatch the AI voice agent (the separate Python worker
// in /abos-chat-ai-agent, deployed on LiveKit Cloud — NOT this Vercel
// app) into that room.
//
// Why explicit dispatch instead of auto-dispatch on room creation:
// auto-dispatch would send the agent into *every* room ever created
// on this LiveKit project, including any future non-AI use of
// LiveKit. Explicit dispatch (agentName must match what the worker
// registers with WorkerOptions) keeps the AI agent scoped to only the
// rooms this endpoint deliberately sends it into.
import { AccessToken, RoomServiceClient, AgentDispatchClient } from "livekit-server-sdk";

function getConfig() {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) {
    throw new Error("Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in Vercel environment variables");
  }
  return { url, apiKey, apiSecret };
}

// LIVEKIT_URL is the wss:// URL clients connect to. The server SDK's
// REST calls (RoomServiceClient, AgentDispatchClient) need the http(s)
// equivalent of the same host.
function toHttpUrl(wsUrl) {
  return wsUrl.replace(/^ws/, "http");
}

export function getPublicLiveKitUrl() {
  return getConfig().url;
}

export async function createLiveKitToken({ identity, name, room, canPublish = true, canSubscribe = true }) {
  const { apiKey, apiSecret } = getConfig();
  const token = new AccessToken(apiKey, apiSecret, { identity, name, ttl: "2h" });
  token.addGrant({ roomJoin: true, room, canPublish, canSubscribe, canPublishData: true });
  return await token.toJwt();
}

export function getRoomServiceClient() {
  const { url, apiKey, apiSecret } = getConfig();
  return new RoomServiceClient(toHttpUrl(url), apiKey, apiSecret);
}

export function getAgentDispatchClient() {
  const { url, apiKey, apiSecret } = getConfig();
  return new AgentDispatchClient(toHttpUrl(url), apiKey, apiSecret);
}

/** Idempotent: safe to call even if the room already exists. */
export async function ensureRoom(roomName, metadata) {
  const rooms = getRoomServiceClient();
  try {
    await rooms.createRoom({
      name: roomName,
      metadata: JSON.stringify(metadata || {}),
      emptyTimeout: 60 * 10, // auto-close if nobody ever joins (customer's browser failed etc.)
    });
  } catch (err) {
    if (!/already exists/i.test(String(err?.message))) throw err;
  }
}

/**
 * Sends the AI agent worker into `roomName`. `agentName` MUST match the
 * `agentName` the Python worker registers in WorkerOptions
 * (see abos-chat-ai-agent/agent.py) or LiveKit will never route the
 * job to it.
 */
export async function dispatchAgent(roomName, agentName, metadata) {
  const dispatch = getAgentDispatchClient();
  return await dispatch.createDispatch(roomName, agentName, {
    metadata: JSON.stringify(metadata || {}),
  });
}
