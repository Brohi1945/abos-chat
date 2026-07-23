// ============================================================
//  src/components/CallManager.tsx
//  Global call state machine — mounted once at the app root.
//  PHASE 1: ICE restart / auto-reconnect logic added.
//  PHASE 1: Dynamic TURN credentials support (await createPeerConnection)
//  PHASE 2: HD Video + Bitrate Control (onPeerConnectionReady callback)
//  PHASE 3: Screen Wake Lock + Quality Monitoring
// ============================================================

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Profile, Call, CallKind } from "../lib/types";
import {
  createCall,
  claimCall,
  endCall,
  getProfileName,
  subscribeToIncomingCalls,
  subscribeToCallRow,
  openCallSignalChannel,
  SignalMessage,
} from "../lib/callApi";
import {
  createPeerConnection,
  getLocalStream,
  stopStream,
  callingIsSupported,
  setBitrateParameters,
  requestWakeLock,
  releaseWakeLock,
  setupWakeLockAutoRenew,
  cleanupWakeLockAutoRenew,
  stopQualityMonitoring,
  CallQualityReport,
} from "../lib/webrtc";
import IncomingCallBanner from "./IncomingCallBanner";
import CallScreen from "./CallScreen";

interface CallContextValue {
  startCall: (conversationId: string, kind: CallKind, peerLabel: string) => void;
}
const CallContext = createContext<CallContextValue | null>(null);
export function useCall() {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used inside CallManager");
  return ctx;
}

const RING_TIMEOUT_MS = 30000;

interface CallManagerProps {
  me: Profile;
  /** The customer's own conversation id — null for owner/agent, who
   *  aren't scoped to a single conversation. */
  myConversationId: string | null;
  children: React.ReactNode;
}

type Phase = "idle" | "outgoing" | "incoming" | "active";

export default function CallManager({ me, myConversationId, children }: CallManagerProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [call, setCall] = useState<Call | null>(null);
  const [peerLabel, setPeerLabel] = useState("");
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [mediaError, setMediaError] = useState("");
  // ---- PHASE 3: Quality report state ----
  const [qualityReport, setQualityReport] = useState<CallQualityReport | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const signalRef = useRef<ReturnType<typeof openCallSignalChannel> | null>(null);
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callRowUnsubRef = useRef<() => void>(() => {});
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  // ---- PHASE 1: ICE restart refs ----
  const restartAttemptedRef = useRef(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetRestartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNegotiatingRef = useRef(false);

  // Ask once, early, so the permission prompt isn't tied to the call
  // moment itself (that would be too late — permission requests need
  // to already be resolved before we can show a notification).
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  function notifyIncoming(call: Call, label: string) {
    if (typeof document === "undefined" || !document.hidden) return; // tab is already visible, banner is enough
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const n = new Notification(`Incoming ${call.kind === "video" ? "video" : "voice"} call`, {
        body: label,
        tag: `abos-chat-call-${call.id}`,
        requireInteraction: true,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      // Notification constructor can throw on some mobile browsers
      // (e.g. it's only allowed via a service worker there) — the
      // in-app ringing banner still works either way, so just skip it.
    }
  }

  // ---- global incoming-call listener ----
  useEffect(() => {
    const unsub = subscribeToIncomingCalls(me, myConversationId, async (incoming) => {
      let alreadyBusy = false;
      setPhase((p) => {
        if (p !== "idle") {
          alreadyBusy = true;
          return p;
        }
        return "incoming";
      });
      if (alreadyBusy) return;
      setCall(incoming);
      let label = "Store";
      if (me.role !== "customer") {
        label = (await getProfileName(incoming.caller_id)) || "Customer";
      }
      setPeerLabel(label);
      notifyIncoming(incoming, label);
    });
    return unsub;
  }, [me.id, myConversationId]);

  // If the ringing call gets cancelled/claimed by someone else while
  // we're showing the incoming banner, dismiss automatically.
  useEffect(() => {
    if (phase !== "incoming" || !call) return;
    const unsub = subscribeToCallRow(call.id, (updated) => {
      if (updated.status !== "ringing" && updated.answered_by !== me.id) {
        resetToIdle();
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, call?.id]);

  // ---- cleanup (shared by resetToIdle and unmount) ----
  const cleanupMedia = () => {
    stopStream(localStream);
    setLocalStream(null);
    setRemoteStream(null);
    pcRef.current?.close();
    pcRef.current = null;
    signalRef.current?.unsubscribe();
    signalRef.current = null;
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
    callRowUnsubRef.current();
    callRowUnsubRef.current = () => {};
    pendingIceRef.current = [];

    // PHASE 1: clear restart-related timeouts
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    if (resetRestartTimeoutRef.current) {
      clearTimeout(resetRestartTimeoutRef.current);
      resetRestartTimeoutRef.current = null;
    }
    restartAttemptedRef.current = false;
    isNegotiatingRef.current = false;

    // PHASE 3: Stop quality monitoring
    stopQualityMonitoring();
    setQualityReport(null);
  };

  const resetToIdle = () => {
    // ---- PHASE 3: Release wake lock ----
    releaseWakeLock();
    cleanupWakeLockAutoRenew();

    cleanupMedia();
    setCall(null);
    setPeerLabel("");
    setPhase("idle");
    setMuted(false);
    setCameraOff(false);
  };

  // ---- begin active call (sets up peer connection + signaling) ----
  const beginActiveCall = async (activeCall: Call, isCaller: boolean) => {
    setPhase("active");

    // ---- PHASE 3: Request Screen Wake Lock ----
    await requestWakeLock();
    setupWakeLockAutoRenew();

    let stream: MediaStream;
    try {
      stream = await getLocalStream(activeCall.kind);
    } catch (err) {
      setMediaError("Camera/mic permission denied ya device nahi mila.");
      await endCall(activeCall, "ended", me);
      resetToIdle();
      return;
    }
    setLocalStream(stream);

    // PHASE 1 + PHASE 2 + PHASE 3: createPeerConnection with all callbacks
    const pc = await createPeerConnection({
      onRemoteStream: (s) => setRemoteStream(s),
      onIceCandidate: (candidate) => signalRef.current?.send({ type: "ice-candidate", candidate, from: me.id }),

      // ---- PHASE 1: ICE connection state listener (restart logic) ----
      onIceConnectionStateChange: (state) => {
        // Only attempt restart if call is active and we're not already trying
        if (phase !== "active") return;
        if (state === "disconnected" || state === "failed") {
          if (restartAttemptedRef.current) return;
          restartAttemptedRef.current = true;

          // Wait 2.5 seconds before restarting — gives network a moment to recover
          if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
          restartTimeoutRef.current = setTimeout(() => {
            // Double-check that call is still active and connection is still bad
            if (phase !== "active") return;
            if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
              restartAttemptedRef.current = false;
              return;
            }
            // Restart ICE — this will trigger onnegotiationneeded
            try {
              pc.restartIce();
            } catch (err) {
              console.error("ICE restart failed:", err);
            }

            // Reset the attempt flag after a cooldown (10s) so we can try again if needed
            if (resetRestartTimeoutRef.current) clearTimeout(resetRestartTimeoutRef.current);
            resetRestartTimeoutRef.current = setTimeout(() => {
              restartAttemptedRef.current = false;
            }, 10000);
          }, 2500);
        } else if (state === "connected" || state === "completed") {
          // Connection recovered — reset attempt flag
          restartAttemptedRef.current = false;
          if (restartTimeoutRef.current) {
            clearTimeout(restartTimeoutRef.current);
            restartTimeoutRef.current = null;
          }
        }
      },

      // ---- PHASE 2: Bitrate parameters set when peer connection is ready ----
      onPeerConnectionReady: (readyPc) => {
        setBitrateParameters(readyPc);
        console.log("✅ Phase 2: Bitrate parameters set on peer connection");
      },

      // ---- PHASE 3: Quality monitoring callback ----
      onQualityReport: (report: CallQualityReport) => {
        setQualityReport(report);
        
        // Show warning if quality is poor
        if (report.quality === 'poor' || report.quality === 'very-poor') {
          console.warn('⚠️ Poor call quality detected:', report);
          const msg = report.quality === 'very-poor' 
            ? '⚠️ Connection very weak — call may drop soon' 
            : '⚠️ Connection weak — quality may be affected';
          setMediaError(msg);
          // Auto-clear after 4 seconds
          setTimeout(() => setMediaError(""), 4000);
        }
      },
    });
    pcRef.current = pc;

    // ---- PHASE 1: negotiation handler for ICE restart ----
    pc.onnegotiationneeded = async () => {
      // Prevent duplicate negotiations
      if (isNegotiatingRef.current) return;
      // Only the caller should initiate negotiation (offer)
      if (!isCaller) return;

      isNegotiatingRef.current = true;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signalRef.current?.send({ type: "offer", sdp: offer, from: me.id });
      } catch (err) {
        console.error("Negotiation needed failed:", err);
      } finally {
        isNegotiatingRef.current = false;
      }
    };

    // ---- Add local tracks to the peer connection ----
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    // ---- Signaling channel ----
    const signal = openCallSignalChannel(activeCall.id, me.id, async (msg: SignalMessage) => {
      if (msg.type === "offer") {
        await pc.setRemoteDescription(msg.sdp);
        for (const c of pendingIceRef.current) await pc.addIceCandidate(c);
        pendingIceRef.current = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signal.send({ type: "answer", sdp: answer, from: me.id });
      } else if (msg.type === "answer") {
        await pc.setRemoteDescription(msg.sdp);
        for (const c of pendingIceRef.current) await pc.addIceCandidate(c);
        pendingIceRef.current = [];
      } else if (msg.type === "ice-candidate") {
        if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
        else pendingIceRef.current.push(msg.candidate);
      } else if (msg.type === "hangup") {
        await endCall(activeCall, "ended", me);
        resetToIdle();
      }
    });
    signalRef.current = signal;

    // ---- Initial offer (only if caller) ----
    if (isCaller) {
      // We set negotiating flag to prevent onnegotiationneeded from firing during manual offer
      isNegotiatingRef.current = true;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signal.send({ type: "offer", sdp: offer, from: me.id });
      } finally {
        isNegotiatingRef.current = false;
      }
    }
  };

  // ---- startCall (outgoing) ----
  const startCall = async (conversationId: string, kind: CallKind, label: string) => {
    if (phase !== "idle") return;
    if (!callingIsSupported()) {
      setMediaError("Is browser/device pe calling support nahi hai.");
      return;
    }
    const created = await createCall(conversationId, me, kind);
    if (!created) return;
    setCall(created);
    setPeerLabel(label);
    setPhase("outgoing");

    callRowUnsubRef.current = subscribeToCallRow(created.id, async (updated) => {
      setCall(updated);
      if (updated.status === "active") {
        if (ringTimeoutRef.current) {
          clearTimeout(ringTimeoutRef.current);
          ringTimeoutRef.current = null;
        }
        callRowUnsubRef.current();
        callRowUnsubRef.current = () => {};
        await beginActiveCall(updated, true);
      } else if (updated.status === "declined" || updated.status === "ended" || updated.status === "missed") {
        resetToIdle();
      }
    });

    ringTimeoutRef.current = setTimeout(async () => {
      await endCall(created, "missed", me);
      resetToIdle();
    }, RING_TIMEOUT_MS);
  };

  // ---- accept incoming ----
  const acceptIncoming = async () => {
    if (!call) return;
    const won = await claimCall(call.id, me);
    if (!won) {
      // a teammate already answered this one
      resetToIdle();
      return;
    }
    const fresh: Call = { ...call, status: "active", answered_by: me.id, answered_at: new Date().toISOString() };
    setCall(fresh);
    await beginActiveCall(fresh, false);
  };

  // ---- decline incoming ----
  const declineIncoming = async () => {
    if (!call) return;
    // Only end the call outright when we're the sole possible
    // recipient (the customer). On the owner/agent side other
    // teammates may still be able to pick up — just dismiss locally.
    if (me.role === "customer") {
      await endCall(call, "declined", me);
    }
    resetToIdle();
  };

  // ---- hangup ----
  const hangup = async () => {
    if (!call) return;
    if (phase === "active") signalRef.current?.send({ type: "hangup", from: me.id });
    await endCall(call, phase === "active" ? "ended" : "missed", me);
    resetToIdle();
  };

  const toggleMute = () => {
    if (!localStream) return;
    const next = !muted;
    localStream.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  };

  const toggleCamera = () => {
    if (!localStream) return;
    const next = !cameraOff;
    localStream.getVideoTracks().forEach((t) => (t.enabled = !next));
    setCameraOff(next);
  };

  // Auto-clear media error after 4s
  useEffect(() => {
    if (!mediaError) return;
    const id = setTimeout(() => setMediaError(""), 4000);
    return () => clearTimeout(id);
  }, [mediaError]);

  // safety cleanup if the whole app unmounts mid-call
  useEffect(() => () => cleanupMedia(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <CallContext.Provider value={{ startCall }}>
      {children}

      {mediaError && (
        <div className="fixed inset-x-0 top-3 z-[80] flex justify-center px-3">
          <div className={`text-white text-xs font-medium px-4 py-2 rounded-full shadow-lg ${
            mediaError.includes('very weak') || mediaError.includes('may drop') 
              ? 'bg-danger/90' 
              : 'bg-warning/90'
          }`}>
            {mediaError}
          </div>
        </div>
      )}

      {phase === "incoming" && call && (
        <IncomingCallBanner call={call} peerLabel={peerLabel} onAccept={acceptIncoming} onDecline={declineIncoming} />
      )}

      {(phase === "outgoing" || phase === "active") && call && (
        <CallScreen
          call={call}
          phase={phase}
          peerLabel={peerLabel}
          localStream={localStream}
          remoteStream={remoteStream}
          muted={muted}
          cameraOff={cameraOff}
          onToggleMute={toggleMute}
          onToggleCamera={toggleCamera}
          onHangup={hangup}
          qualityReport={qualityReport}
        />
      )}
    </CallContext.Provider>
  );
}
