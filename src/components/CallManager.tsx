// ============================================================
//  src/components/CallManager.tsx
//  Complete Call Manager — Phase 1 to 7
//  - TURN + ICE Restart (Phase 1)
//  - HD + Bitrate (Phase 2)
//  - Wake Lock + Quality (Phase 3)
//  - Rate Limit (Phase 4)
//  - Call Waiting (Phase 6)
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
  const [qualityReport, setQualityReport] = useState<CallQualityReport | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const signalRef = useRef<ReturnType<typeof openCallSignalChannel> | null>(null);
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callRowUnsubRef = useRef<() => void>(() => {});
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  // ---- ICE restart refs ----
  const restartAttemptedRef = useRef(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetRestartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNegotiatingRef = useRef(false);

  // ---- Request notification permission ----
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  function notifyIncoming(call: Call, label: string) {
    if (typeof document === "undefined" || !document.hidden) return;
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
      // ignore
    }
  }

  // ---- Incoming call listener ----
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

      // ---- Phase 6: Call waiting ----
      if (incoming.status === 'waiting') {
        setMediaError('📞 Already on a call — waiting for next call');
        setTimeout(() => setMediaError(""), 5000);
        return;
      }

      notifyIncoming(incoming, label);
    });
    return unsub;
  }, [me.id, myConversationId]);

  // ---- Auto-dismiss if claimed by someone else ----
  useEffect(() => {
    if (phase !== "incoming" || !call) return;
    const unsub = subscribeToCallRow(call.id, (updated) => {
      if (updated.status !== "ringing" && updated.answered_by !== me.id) {
        resetToIdle();
      }
    });
    return unsub;
  }, [phase, call?.id]);

  // ---- Cleanup ----
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

    stopQualityMonitoring();
    setQualityReport(null);
  };

  const resetToIdle = () => {
    releaseWakeLock();
    cleanupWakeLockAutoRenew();
    cleanupMedia();
    setCall(null);
    setPeerLabel("");
    setPhase("idle");
    setMuted(false);
    setCameraOff(false);
  };

  // ---- Begin Active Call ----
  const beginActiveCall = async (activeCall: Call, isCaller: boolean) => {
    setPhase("active");

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

    const pc = await createPeerConnection({
      onRemoteStream: (s) => setRemoteStream(s),
      onIceCandidate: (candidate) => signalRef.current?.send({ type: "ice-candidate", candidate, from: me.id }),

      onIceConnectionStateChange: (state) => {
        if (phase !== "active") return;
        if (state === "disconnected" || state === "failed") {
          if (restartAttemptedRef.current) return;
          restartAttemptedRef.current = true;

          if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
          restartTimeoutRef.current = setTimeout(() => {
            if (phase !== "active") return;
            if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
              restartAttemptedRef.current = false;
              return;
            }
            try {
              pc.restartIce();
            } catch (err) {
              console.error("ICE restart failed:", err);
            }

            if (resetRestartTimeoutRef.current) clearTimeout(resetRestartTimeoutRef.current);
            resetRestartTimeoutRef.current = setTimeout(() => {
              restartAttemptedRef.current = false;
            }, 10000);
          }, 2500);
        } else if (state === "connected" || state === "completed") {
          restartAttemptedRef.current = false;
          if (restartTimeoutRef.current) {
            clearTimeout(restartTimeoutRef.current);
            restartTimeoutRef.current = null;
          }
        }
      },

      onPeerConnectionReady: (readyPc) => {
        setBitrateParameters(readyPc);
        console.log("✅ Phase 2: Bitrate parameters set");
      },

      onQualityReport: (report: CallQualityReport) => {
        setQualityReport(report);
        if (report.quality === 'poor' || report.quality === 'very-poor') {
          console.warn('⚠️ Poor call quality detected:', report);
          const msg = report.quality === 'very-poor'
            ? '⚠️ Connection very weak — call may drop soon'
            : '⚠️ Connection weak — quality may be affected';
          setMediaError(msg);
          setTimeout(() => setMediaError(""), 4000);
        }
      },
    });
    pcRef.current = pc;

    pc.onnegotiationneeded = async () => {
      if (isNegotiatingRef.current) return;
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

    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

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

    if (isCaller) {
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

  // ---- Start Call ----
  const startCall = async (conversationId: string, kind: CallKind, label: string) => {
    if (phase !== "idle") return;
    if (!callingIsSupported()) {
      setMediaError("Is browser/device pe calling support nahi hai.");
      return;
    }

    try {
      const created = await createCall(conversationId, me, kind);
      if (!created) {
        setMediaError("Call create nahi ho saki — dobara try karo.");
        return;
      }
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
    } catch (err: any) {
      if (err.message?.includes('Too many calls')) {
        setMediaError('⏳ Bohat zyada calls — thodi der baad try karo.');
        setTimeout(() => setMediaError(""), 5000);
      } else {
        setMediaError('Call start nahi ho saki: ' + err.message);
      }
    }
  };

  // ---- Accept incoming ----
  const acceptIncoming = async () => {
    if (!call) return;
    const won = await claimCall(call.id, me);
    if (!won) {
      resetToIdle();
      return;
    }
    const fresh: Call = { ...call, status: "active", answered_by: me.id, answered_at: new Date().toISOString() };
    setCall(fresh);
    await beginActiveCall(fresh, false);
  };

  // ---- Decline incoming ----
  const declineIncoming = async () => {
    if (!call) return;
    if (me.role === "customer") {
      await endCall(call, "declined", me);
    }
    resetToIdle();
  };

  // ---- Hangup ----
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

  useEffect(() => {
    if (!mediaError) return;
    const id = setTimeout(() => setMediaError(""), 4000);
    return () => clearTimeout(id);
  }, [mediaError]);

  useEffect(() => () => cleanupMedia(), []);

  return (
    <CallContext.Provider value={{ startCall }}>
      {children}

      {mediaError && (
        <div className="fixed inset-x-0 top-3 z-[80] flex justify-center px-3">
          <div className={`text-white text-xs font-medium px-4 py-2 rounded-full shadow-lg ${
            mediaError.includes('very weak') || mediaError.includes('may drop')
              ? 'bg-danger/90'
              : mediaError.includes('Too many') || mediaError.includes('waiting')
              ? 'bg-warning/90'
              : 'bg-danger/90'
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
