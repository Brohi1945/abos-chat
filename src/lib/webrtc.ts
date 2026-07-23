// ============================================================
//  src/lib/webrtc.ts
//  PHASE 1 + DYNAMIC TURN CREDENTIALS (from metered.ca)
//  Fetches fresh TURN credentials before every call.
//  No static credentials stored in code or env.
// ============================================================

import { CallKind } from "./types";

// Fallback STUN servers (used if TURN fetch fails)
const FALLBACK_STUN: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * Fetches fresh, time-limited TURN credentials from our Vercel endpoint.
 * This endpoint calls metered.ca internally, so the browser never
 * sees the raw API key.
 * 
 * Credentials are valid for 24 hours by default.
 */
async function fetchTurnServers(): Promise<RTCIceServer[]> {
  try {
    const response = await fetch("/api/turn-credentials");
    
    if (!response.ok) {
      console.warn("Failed to fetch TURN credentials, falling back to STUN only");
      return [...FALLBACK_STUN];
    }
    
    const data = await response.json();
    
    if (data.iceServers && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      return data.iceServers;
    }
    
    return [...FALLBACK_STUN];
  } catch (err) {
    console.warn("Error fetching TURN credentials:", err);
    return [...FALLBACK_STUN];
  }
}

/**
 * Builds the full ICE server list dynamically.
 * This is ASYNC — call it before creating the peer connection.
 */
export async function getIceServers(): Promise<RTCIceServer[]> {
  return await fetchTurnServers();
}

export interface PeerCallbacks {
  /** Called when a remote MediaStream (audio/video) arrives. */
  onRemoteStream: (stream: MediaStream) => void;

  /** Called whenever a new ICE candidate is gathered. */
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;

  /** Optional: RTCPeerConnection-level state changes. */
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;

  /**
   * PHASE 1 ADDITION: ICE connection state changes.
   * CallManager uses this to detect "disconnected" / "failed" and
   * trigger an ICE restart.
   */
  onIceConnectionStateChange?: (state: RTCIceConnectionState) => void;
}

/**
 * Creates a new RTCPeerConnection with DYNAMIC TURN credentials.
 * Must be called with `await` because it fetches credentials first.
 */
export async function createPeerConnection(
  callbacks: PeerCallbacks
): Promise<RTCPeerConnection> {
  const iceServers = await getIceServers();

  const pc = new RTCPeerConnection({
    iceServers,
    // Optionally force TURN only for testing (uncomment to debug):
    // iceTransportPolicy: "relay",
  });

  // Forward ICE candidates to the signaling channel
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      callbacks.onIceCandidate(e.candidate.toJSON());
    }
  };

  // Forward remote tracks (audio/video) to the UI
  pc.ontrack = (e) => {
    if (e.streams[0]) {
      callbacks.onRemoteStream(e.streams[0]);
    }
  };

  // Optional: peer connection state (overall connection health)
  if (callbacks.onConnectionStateChange) {
    pc.onconnectionstatechange = () => {
      callbacks.onConnectionStateChange!(pc.connectionState);
    };
  }

  // PHASE 1: ICE connection state — used to detect when we need to restart
  if (callbacks.onIceConnectionStateChange) {
    pc.oniceconnectionstatechange = () => {
      callbacks.onIceConnectionStateChange!(pc.iceConnectionState);
    };
  }

  return pc;
}

/**
 * Acquires local audio (and optionally video) stream.
 * PHASE 2 will add HD resolution constraints here.
 */
export async function getLocalStream(kind: CallKind): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: kind === "video" ? { facingMode: "user" } : false,
  };

  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * Stops all tracks in a MediaStream (releases camera/mic).
 */
export function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}

/**
 * Quick feature-detection: does this browser support WebRTC calling?
 */
export function callingIsSupported(): boolean {
  return !!(navigator.mediaDevices && window.RTCPeerConnection);
}
