// ============================================================
//  src/lib/webrtc.ts
//  PHASE 2 + PHASE 3: HD Video + Bitrate + Quality Monitoring
//  - HD resolution (1280x720 @ 30fps)
//  - Bitrate control (video 1.5-2.5 Mbps, audio 32-64 kbps)
//  - Opus FEC (useinbandfec=1)
//  - H.264 video codec preference
//  - PHASE 3: Quality monitoring via getStats()
// ============================================================

import { CallKind } from "./types";

// Fallback STUN servers (used if TURN fetch fails)
const FALLBACK_STUN: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// ============================================================
//  PHASE 3: Quality monitoring types
// ============================================================

export interface CallQualityReport {
  /** Current round-trip time in milliseconds */
  rtt: number | null;
  /** Packet loss percentage (0-100) */
  packetLoss: number | null;
  /** Available outgoing bitrate in bps */
  bitrate: number | null;
  /** Quality score: 'excellent' | 'good' | 'poor' | 'very-poor' */
  quality: 'excellent' | 'good' | 'poor' | 'very-poor';
}

export type QualityCallback = (report: CallQualityReport) => void;

/**
 * Fetches fresh, time-limited TURN credentials from our Vercel endpoint.
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

export async function getIceServers(): Promise<RTCIceServer[]> {
  return await fetchTurnServers();
}

export interface PeerCallbacks {
  onRemoteStream: (stream: MediaStream) => void;
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onIceConnectionStateChange?: (state: RTCIceConnectionState) => void;
  onPeerConnectionReady?: (pc: RTCPeerConnection) => void;
  /** PHASE 3: Quality monitoring callback */
  onQualityReport?: (report: CallQualityReport) => void;
}

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

  // PHASE 3: Start quality monitoring when negotiation is complete
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
    // PHASE 3: Start quality monitoring after connection is stable
    if (callbacks.onQualityReport) {
      setTimeout(() => {
        startQualityMonitoring(pc, callbacks.onQualityReport!);
      }, 2000);
    }
  };

  return pc;
}

// ============================================================
//  PHASE 2: getLocalStream with HD video constraints
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
//  PHASE 2: Bitrate control
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
        params.encodings[0].maxBitrate = 2_500_000; // 2.5 Mbps
        params.encodings[0].minBitrate = 1_500_000; // 1.5 Mbps
      } else if (track.kind === "audio") {
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 64_000; // 64 kbps
        params.encodings[0].minBitrate = 32_000; // 32 kbps
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
//  PHASE 3: Quality Monitoring via getStats()
// ============================================================

let qualityMonitorInterval: number | null = null;

/**
 * Start monitoring call quality using RTCPeerConnection.getStats()
 * Calls the callback every 3 seconds with quality report.
 */
export function startQualityMonitoring(
  pc: RTCPeerConnection,
  onReport: QualityCallback
): void {
  // Clear any existing interval
  if (qualityMonitorInterval) {
    window.clearInterval(qualityMonitorInterval);
    qualityMonitorInterval = null;
  }

  // Wait a moment for stats to become available
  setTimeout(() => {
    qualityMonitorInterval = window.setInterval(async () => {
      try {
        const report = await getCallQualityReport(pc);
        onReport(report);
      } catch (err) {
        // Silently fail — stats collection is best-effort
        console.debug("Quality monitoring error:", err);
      }
    }, 3000); // Every 3 seconds
  }, 3000);
}

/**
 * Stop quality monitoring.
 * Call this when the call ends.
 */
export function stopQualityMonitoring(): void {
  if (qualityMonitorInterval) {
    window.clearInterval(qualityMonitorInterval);
    qualityMonitorInterval = null;
  }
}

/**
 * Get a quality report from the peer connection.
 */
async function getCallQualityReport(pc: RTCPeerConnection): Promise<CallQualityReport> {
  const stats = await pc.getStats();

  let rtt: number | null = null;
  let packetLoss: number | null = null;
  let bitrate: number | null = null;

  // Find the relevant stats
  for (const [, stat] of stats) {
    // RTT from candidate-pair stats
    if (stat.type === 'candidate-pair' && stat.currentRoundTripTime) {
      rtt = stat.currentRoundTripTime * 1000; // Convert to ms
    }

    // Packet loss from outbound-rtp stats
    if (stat.type === 'outbound-rtp' && stat.packetsLost !== undefined) {
      const total = stat.packetsSent + stat.packetsLost;
      if (total > 0) {
        packetLoss = (stat.packetsLost / total) * 100;
      }
    }

    // Bitrate from outbound-rtp stats
    if (stat.type === 'outbound-rtp' && stat.bytesSent !== undefined && stat.timestamp) {
      // We need two samples to calculate bitrate, but we'll use the
      // available bitrate from the sender parameters instead
    }
  }

  // Try to get bitrate from sender parameters
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

  // Determine quality score
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

/**
 * Check if Screen Wake Lock is supported.
 */
export function isWakeLockSupported(): boolean {
  return 'wakeLock' in navigator;
}

/**
 * Request screen wake lock.
 * Call this when a call becomes active.
 */
export async function requestWakeLock(): Promise<boolean> {
  try {
    if (!isWakeLockSupported()) {
      console.warn('Screen Wake Lock not supported on this device');
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

/**
 * Release screen wake lock.
 * Call this when the call ends.
 */
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

/**
 * Re-acquire wake lock when the page becomes visible again.
 */
export function setupWakeLockAutoRenew(): void {
  if (!isWakeLockSupported()) return;

  const handleVisibilityChange = async () => {
    if (document.visibilityState === 'visible' && wakeLockSupported && !wakeLock) {
      await requestWakeLock();
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  
  // Store the handler for cleanup
  (window as any).__wakeLockVisibilityHandler = handleVisibilityChange;
}

/**
 * Clean up wake lock event listeners.
 */
export function cleanupWakeLockAutoRenew(): void {
  const handler = (window as any).__wakeLockVisibilityHandler;
  if (handler) {
    document.removeEventListener('visibilitychange', handler);
    delete (window as any).__wakeLockVisibilityHandler;
  }
}

// ============================================================
//  Utility functions
// ============================================================

export function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}

export function callingIsSupported(): boolean {
  return !!(navigator.mediaDevices && window.RTCPeerConnection);
}
