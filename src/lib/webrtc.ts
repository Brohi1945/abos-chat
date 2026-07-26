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
    sampleRate: { ideal: 48000 },
    channelCount: { ideal: 1 },
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
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      // NOTE: minBitrate was never a real field on RTCRtpEncodingParameters
      // (spec only defines maxBitrate) — setting it did nothing useful and
      // risked the browser rejecting the whole setParameters() call on
      // stricter engines, silently leaving EVERYTHING here unapplied.
      if (track.kind === "video") {
        params.encodings[0].maxBitrate = 2_500_000;
      } else if (track.kind === "audio") {
        // Ceiling only — tuneOpusAudio() (webrtc.ts, applied to the SDP
        // before setLocalDescription) is what actually drives Opus's real
        // target bitrate via maxaveragebitrate. This cap just needs to sit
        // comfortably above that so it's never the limiting factor.
        params.encodings[0].maxBitrate = 128_000;
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
//  PHASE 9: HD Voice — Opus SDP tuning
// ============================================================
// Fixes "sounds like a bad radio station" audio: that's the classic
// symptom of Opus running with DTX (Discontinuous Transmission — it stops
// sending real audio during quiet gaps and lets the other side's decoder
// guess/generate comfort noise instead, which sounds crackly/robotic when
// the network is anything less than perfect) and no FEC (so any lost
// packet is just gone — audible as a sharp click/static burst instead of
// being smoothly reconstructed from redundancy in the next packet).
// Neither of these is controllable via RTCRtpSender.setParameters() — for
// Opus they're negotiated in the SDP's a=fmtp line, so we edit the offer/
// answer SDP directly, right before setLocalDescription().
export function tuneOpusAudio(sdp: string): string {
  const rtpmapMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000(?:\/\d+)?/i);
  if (!rtpmapMatch) return sdp; // no Opus in this SDP — leave untouched

  const payloadType = rtpmapMatch[1];
  const desired: Record<string, string> = {
    useinbandfec: "1", // forward error correction — smooths over lost packets instead of audible gaps/clicks
    usedtx: "0", // always send real audio; no synthetic comfort-noise fill during pauses
    stereo: "0", // voice call — mono is enough and leaves more bit budget for the actual signal
    maxaveragebitrate: "32000", // ~32kbps mono fullband Opus is solidly "HD Voice" territory
  };

  const fmtpRegex = new RegExp(`a=fmtp:${payloadType} ([^\r\n]*)`, "i");
  const fmtpMatch = sdp.match(fmtpRegex);

  if (fmtpMatch) {
    const params = new Map<string, string>();
    fmtpMatch[1].split(";").forEach((pair) => {
      const [k, v] = pair.split("=");
      if (k) params.set(k.trim(), (v ?? "").trim());
    });
    Object.entries(desired).forEach(([k, v]) => params.set(k, v));
    const rebuilt = Array.from(params.entries())
      .map(([k, v]) => (v ? `${k}=${v}` : k))
      .join(";");
    return sdp.replace(fmtpMatch[0], `a=fmtp:${payloadType} ${rebuilt}`);
  }

  // No existing fmtp line for this payload type — add one right after rtpmap.
  const newFmtpLine = `a=fmtp:${payloadType} ${Object.entries(desired)
    .map(([k, v]) => `${k}=${v}`)
    .join(";")}`;
  return sdp.replace(rtpmapMatch[0], `${rtpmapMatch[0]}\r\n${newFmtpLine}`);
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
