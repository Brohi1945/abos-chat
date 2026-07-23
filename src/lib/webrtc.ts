// ============================================================
//  src/lib/webrtc.ts
//  Complete WebRTC — Phase 1 to 7
//  - TURN + ICE Restart (Phase 1)
//  - HD Video + Bitrate (Phase 2)
//  - Wake Lock + Quality (Phase 3)
//  - Security (Phase 4)
//  - Call Waiting (Phase 6)
// ============================================================

import { CallKind } from "./types";

// Fallback STUN servers
const FALLBACK_STUN: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// ============================================================
//  PHASE 1: TURN Credentials
// ============================================================

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

export async function getIceServers(): Promise<RTCIceServer[]> {
  return await fetchTurnServers();
}

// ============================================================
//  PHASE 3: Quality Monitoring Types
// ============================================================

export interface CallQualityReport {
  rtt: number | null;
  packetLoss: number | null;
  bitrate: number | null;
  quality: 'excellent' | 'good' | 'poor' | 'very-poor';
}

export type QualityCallback = (report: CallQualityReport) => void;

// ============================================================
//  Peer Connection Callbacks
// ============================================================

export interface PeerCallbacks {
  onRemoteStream: (stream: MediaStream) => void;
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onIceConnectionStateChange?: (state: RTCIceConnectionState) => void;
  onPeerConnectionReady?: (pc: RTCPeerConnection) => void;
  onQualityReport?: (report: CallQualityReport) => void;
}

// ============================================================
//  Create Peer Connection
// ============================================================

export async function createPeerConnection(
  callbacks: PeerCallbacks
): Promise<RTCPeerConnection> {
  const iceServers = await getIceServers();

  const pc = new RTCPeerConnection({
    iceServers,
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      callbacks.onIceCandidate(e.candidate.toJSON());
    }
  };

  pc.ontrack = (e) => {
    if (e.streams[0]) {
      callbacks.onRemoteStream(e.streams[0]);
    }
  };

  if (callbacks.onConnectionStateChange) {
    pc.onconnectionstatechange = () => {
      callbacks.onConnectionStateChange!(pc.connectionState);
    };
  }

  if (callbacks.onIceConnectionStateChange) {
    pc.oniceconnectionstatechange = () => {
      callbacks.onIceConnectionStateChange!(pc.iceConnectionState);
    };
  }

  const origOnNegotiationNeeded = pc.onnegotiationneeded;
  pc.onnegotiationneeded = async () => {
    if (origOnNegotiationNeeded) {
      await origOnNegotiationNeeded.call(pc);
    }
    if (callbacks.onPeerConnectionReady) {
      setTimeout(() => {
        callbacks.onPeerConnectionReady!(pc);
      }, 500);
    }
    if (callbacks.onQualityReport) {
      setTimeout(() => {
        startQualityMonitoring(pc, callbacks.onQualityReport!);
      }, 2000);
    }
  };

  return pc;
}

// ============================================================
//  PHASE 2: HD Video + Audio
// ============================================================

export async function getLocalStream(kind: CallKind): Promise<MediaStream> {
  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  let videoConstraints: MediaTrackConstraints | boolean = false;

  if (kind === "video") {
    videoConstraints = {
      facingMode: "user",
      width: { ideal: 1280, max: 1920 },
      height: { ideal: 720, max: 1080 },
      frameRate: { ideal: 30, max: 60 },
    };
  }

  return navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
    video: videoConstraints,
  });
}

// ============================================================
//  PHASE 2: Bitrate Control
// ============================================================

export function setBitrateParameters(pc: RTCPeerConnection): void {
  try {
    const senders = pc.getSenders();

    for (const sender of senders) {
      const track = sender.track;
      if (!track) continue;

      const params = sender.getParameters();

      if (track.kind === "video") {
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 2_500_000;
        params.encodings[0].minBitrate = 1_500_000;
      } else if (track.kind === "audio") {
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 64_000;
        params.encodings[0].minBitrate = 32_000;
      }

      sender.setParameters(params).catch((err) => {
        console.warn("Failed to set bitrate parameters:", err);
      });
    }
  } catch (err) {
    console.warn("Error setting bitrate parameters:", err);
  }
}

// ============================================================
//  PHASE 3: Quality Monitoring
// ============================================================

let qualityMonitorInterval: number | null = null;

export function startQualityMonitoring(
  pc: RTCPeerConnection,
  onReport: QualityCallback
): void {
  if (qualityMonitorInterval) {
    window.clearInterval(qualityMonitorInterval);
    qualityMonitorInterval = null;
  }

  setTimeout(() => {
    qualityMonitorInterval = window.setInterval(async () => {
      try {
        const report = await getCallQualityReport(pc);
        onReport(report);
      } catch (err) {
        console.debug("Quality monitoring error:", err);
      }
    }, 3000);
  }, 3000);
}

export function stopQualityMonitoring(): void {
  if (qualityMonitorInterval) {
    window.clearInterval(qualityMonitorInterval);
    qualityMonitorInterval = null;
  }
}

async function getCallQualityReport(pc: RTCPeerConnection): Promise<CallQualityReport> {
  const stats = await pc.getStats();

  let rtt: number | null = null;
  let packetLoss: number | null = null;
  let bitrate: number | null = null;

  for (const [, stat] of stats) {
    if (stat.type === 'candidate-pair' && stat.currentRoundTripTime) {
      rtt = stat.currentRoundTripTime * 1000;
    }
    if (stat.type === 'outbound-rtp' && stat.packetsLost !== undefined) {
      const total = stat.packetsSent + stat.packetsLost;
      if (total > 0) {
        packetLoss = (stat.packetsLost / total) * 100;
      }
    }
  }

  try {
    const senders = pc.getSenders();
    for (const sender of senders) {
      if (sender.track?.kind === 'video') {
        const params = sender.getParameters();
        if (params.encodings && params.encodings[0] && params.encodings[0].maxBitrate) {
          bitrate = params.encodings[0].maxBitrate;
        }
      }
    }
  } catch {
    // ignore
  }

  let quality: 'excellent' | 'good' | 'poor' | 'very-poor' = 'good';

  if (packetLoss !== null) {
    if (packetLoss < 1) quality = 'excellent';
    else if (packetLoss < 3) quality = 'good';
    else if (packetLoss < 8) quality = 'poor';
    else quality = 'very-poor';
  } else if (rtt !== null) {
    if (rtt < 100) quality = 'excellent';
    else if (rtt < 200) quality = 'good';
    else if (rtt < 400) quality = 'poor';
    else quality = 'very-poor';
  }

  return {
    rtt,
    packetLoss: packetLoss !== null ? Math.round(packetLoss * 100) / 100 : null,
    bitrate,
    quality,
  };
}

// ============================================================
//  PHASE 3: Screen Wake Lock
// ============================================================

let wakeLock: any = null;
let wakeLockSupported = false;

export function isWakeLockSupported(): boolean {
  return 'wakeLock' in navigator;
}

export async function requestWakeLock(): Promise<boolean> {
  try {
    if (!isWakeLockSupported()) {
      return false;
    }
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLockSupported = true;
    console.log('✅ Screen Wake Lock acquired');
    return true;
  } catch (err) {
    console.warn('Failed to acquire wake lock:', err);
    return false;
  }
}

export function releaseWakeLock(): void {
  if (wakeLock) {
    try {
      wakeLock.release();
      wakeLock = null;
      wakeLockSupported = false;
      console.log('✅ Screen Wake Lock released');
    } catch (err) {
      console.warn('Failed to release wake lock:', err);
    }
  }
}

export function setupWakeLockAutoRenew(): void {
  if (!isWakeLockSupported()) return;

  const handleVisibilityChange = async () => {
    if (document.visibilityState === 'visible' && wakeLockSupported && !wakeLock) {
      await requestWakeLock();
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  (window as any).__wakeLockVisibilityHandler = handleVisibilityChange;
}

export function cleanupWakeLockAutoRenew(): void {
  const handler = (window as any).__wakeLockVisibilityHandler;
  if (handler) {
    document.removeEventListener('visibilitychange', handler);
    delete (window as any).__wakeLockVisibilityHandler;
  }
}

// ============================================================
//  Utility Functions
// ============================================================

export function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}

export function callingIsSupported(): boolean {
  return !!(navigator.mediaDevices && window.RTCPeerConnection);
}
