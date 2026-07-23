// ============================================================
//  src/lib/webrtc.ts
//  WebRTC peer connection + media helpers.
//  PHASE 1: TURN server support added (via environment variables).
//  PHASE 1: ICE restart callbacks prepared (actual logic lives in
//  CallManager.tsx, but the callback hook is exposed here).
// ============================================================

import { CallKind } from "./types";

// Google STUN servers — free, reliable for most home/mobile networks
const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * Builds the full ICE server list.
 * If TURN credentials are present in environment variables, they are added.
 * TURN URL format: "turn:your-turn-server.com:3478" or "turns:..." for TLS.
 */
function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [...STUN_SERVERS];

  // Read TURN config from environment (VITE_ prefix because it's used in the browser)
  const turnUrl = import.meta.env.VITE_TURN_URL;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

  if (turnUrl && turnUsername && turnCredential) {
    servers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return servers;
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
 * Creates a new RTCPeerConnection with the configured ICE servers
 * (STUN + optional TURN) and wires up all callbacks.
 */
export function createPeerConnection(callbacks: PeerCallbacks): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: getIceServers(),
    // Optional: if you want to configure additional ICE settings
    // iceTransportPolicy: "all", // "relay" forces TURN-only (debugging)
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
 * PHASE 2 will add HD resolution constraints here — for now we keep
 * it as-is to avoid breaking existing behaviour.
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
