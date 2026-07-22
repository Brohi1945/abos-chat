import { CallKind } from "./types";

// STUN-only (free, no signup). This resolves both sides' public
// address so most home/mobile networks can connect directly — but
// there's no TURN server here, so calls between two networks with
// strict/symmetric NAT (common on some corporate wifi or carrier-grade
// NAT) can fail to establish. Adding a TURN server (e.g. Twilio NTS,
// metered.ca, or self-hosted coturn) is the fix if that turns out to
// matter for your users — flag it and we'll wire it in.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export interface PeerCallbacks {
  onRemoteStream: (stream: MediaStream) => void;
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
}

export function createPeerConnection(callbacks: PeerCallbacks): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (e) => {
    if (e.candidate) callbacks.onIceCandidate(e.candidate.toJSON());
  };

  pc.ontrack = (e) => {
    if (e.streams[0]) callbacks.onRemoteStream(e.streams[0]);
  };

  if (callbacks.onConnectionStateChange) {
    pc.onconnectionstatechange = () => callbacks.onConnectionStateChange!(pc.connectionState);
  }

  return pc;
}

export async function getLocalStream(kind: CallKind): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: kind === "video" ? { facingMode: "user" } : false,
  });
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function callingIsSupported(): boolean {
  return !!(navigator.mediaDevices && window.RTCPeerConnection);
}
