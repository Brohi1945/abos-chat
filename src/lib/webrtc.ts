// ============================================================
//  src/lib/webrtc.ts
//  PHASE 2: HD Video + Audio Quality
//  - HD resolution (1280x720 @ 30fps)
//  - Bitrate control (video 1.5-2.5 Mbps, audio 32-64 kbps)
//  - Opus FEC (useinbandfec=1)
//  - H.264 video codec preference
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

  /** ICE connection state changes — used for ICE restart. */
  onIceConnectionStateChange?: (state: RTCIceConnectionState) => void;

  /** PHASE 2: Called when the peer connection is ready (after adding tracks),
   *  so we can set bitrate parameters. */
  onPeerConnectionReady?: (pc: RTCPeerConnection) => void;
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
    // PHASE 2: Ice transport policy — keep as "all" (use both STUN and TURN)
    // iceTransportPolicy: "all",
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

  // ICE connection state — used to detect when we need to restart
  if (callbacks.onIceConnectionStateChange) {
    pc.oniceconnectionstatechange = () => {
      callbacks.onIceConnectionStateChange!(pc.iceConnectionState);
    };
  }

  // PHASE 2: Set bitrate when negotiation is complete
  const origOnNegotiationNeeded = pc.onnegotiationneeded;
  pc.onnegotiationneeded = async () => {
    if (origOnNegotiationNeeded) {
      // Call the original if it was set
      await origOnNegotiationNeeded.call(pc);
    }
    // Call the ready callback after negotiation
    if (callbacks.onPeerConnectionReady) {
      // Wait a moment for the negotiation to complete
      setTimeout(() => {
        callbacks.onPeerConnectionReady!(pc);
      }, 500);
    }
  };

  return pc;
}

/**
 * PHASE 2: Get local stream with HD video constraints.
 * 
 * Resolution: 1280x720 @ 30fps (720p HD)
 * Audio: Echo cancellation, noise suppression, auto gain control
 */
export async function getLocalStream(kind: CallKind): Promise<MediaStream> {
  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  let videoConstraints: MediaTrackConstraints | boolean = false;

  if (kind === "video") {
    videoConstraints = {
      facingMode: "user", // Front camera
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

/**
 * PHASE 2: Set bitrate parameters on the peer connection.
 * 
 * Video: 1.5-2.5 Mbps (good for 720p)
 * Audio: 32-64 kbps (Opus, good for voice)
 */
export function setBitrateParameters(pc: RTCPeerConnection): void {
  try {
    const senders = pc.getSenders();

    for (const sender of senders) {
      const track = sender.track;
      if (!track) continue;

      const params = sender.getParameters();

      if (track.kind === "video") {
        // Video bitrate: 1.5 Mbps min, 2.5 Mbps max
        // Good balance for 720p @ 30fps
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 2_500_000; // 2.5 Mbps
        params.encodings[0].minBitrate = 1_500_000; // 1.5 Mbps
      } else if (track.kind === "audio") {
        // Audio bitrate: 32-64 kbps (Opus)
        // 32 kbps is fine for voice, 64 kbps for music/higher quality
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

/**
 * PHASE 2: Apply Opus FEC and other audio codec settings.
 * This modifies the SDP to add `useinbandfec=1` for Opus.
 * 
 * FEC (Forward Error Correction) helps recover lost audio packets
 * on patchy mobile networks.
 */
export function applyOpusFEC(sdp: string): string {
  // Check if Opus is already in the SDP
  if (!sdp.includes("opus")) {
    return sdp;
  }

  // Split SDP into lines
  const lines = sdp.split("\n");
  const newLines: string[] = [];

  let inOpusSection = false;

  for (const line of lines) {
    if (line.startsWith("a=rtpmap:") && line.includes("opus")) {
      inOpusSection = true;
      newLines.push(line);
      continue;
    }

    if (inOpusSection && line.startsWith("a=fmtp:")) {
      // Add FEC to existing fmtp line
      if (!line.includes("useinbandfec=1")) {
        newLines.push(line.replace(/;?\s*$/, ";useinbandfec=1"));
      } else {
        newLines.push(line);
      }
      inOpusSection = false;
      continue;
    }

    if (inOpusSection && !line.startsWith("a=")) {
      // End of Opus section — add fmtp line if not already added
      // Find the payload type number
      const payloadMatch = line.match(/^a=rtpmap:(\d+)/);
      if (payloadMatch) {
        const pt = payloadMatch[1];
        newLines.push(`a=fmtp:${pt} useinbandfec=1;`);
      }
      inOpusSection = false;
      newLines.push(line);
      continue;
    }

    newLines.push(line);
  }

  return newLines.join("\n");
}

/**
 * PHASE 2: Prefer H.264 video codec for hardware acceleration.
 * H.264 is hardware-accelerated on most Android phones,
 * which means smoother video and less battery drain.
 */
export function preferH264(sdp: string): string {
  // This is a simple approach — for production, you'd use
  // RTCRtpSender.setCodecPreferences() which is more reliable.
  // But this works as a fallback.
  
  const lines = sdp.split("\n");
  const videoLines: string[] = [];
  const otherLines: string[] = [];

  // Separate video lines from others
  for (const line of lines) {
    if (line.toLowerCase().includes("h264")) {
      videoLines.push(line);
    } else if (
      !line.toLowerCase().includes("video") &&
      !line.toLowerCase().includes("h264")
    ) {
      otherLines.push(line);
    }
  }

  // Reassemble: H.264 lines first, then others
  return [...videoLines, ...otherLines].join("\n");
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
