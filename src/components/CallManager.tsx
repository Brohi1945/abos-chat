// src/components/CallManager.tsx

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Profile, Call, CallKind } from "../lib/types";
import {
  createCall,
  claimCall,
  endCall,
  endCallBeacon,
  getProfileName,
  subscribeToIncomingCalls,
  subscribeToCallRow,
  subscribeToRingAck,
  sendRingAck,
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
type RingStatus = "calling" | "ringing";

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
  const [responding, setResponding] = useState(false);
  // ---- "Calling…" vs "Ringing…" (WhatsApp-style) ----
  // Starts "calling" the instant we dial. Flips to "ringing" only once
  // the other device's IncomingCallBanner has actually mounted and
  // acked back (see sendRingAck in the incoming-call listener below).
  // If the other side has no network / app closed, no ack ever arrives,
  // so it correctly stays "calling" until the ring times out.
  const [ringStatus, setRingStatus] = useState<RingStatus>("calling");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const signalRef = useRef<ReturnType<typeof openCallSignalChannel> | null>(null);
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callRowUnsubRef = useRef<() => void>(() => {});
  const ringAckUnsubRef = useRef<() => void>(() => {});
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  // ---- Debounce guards against double-tap races ----
  const respondingRef = useRef(false);
  const startingCallRef = useRef(false);

  // ---- ICE restart refs ----
  const restartAttemptedRef = useRef(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetRestartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNegotiatingRef = useRef(false);

  // ---- Keep a live snapshot of call/phase for the unload handler ----
  // beforeunload/pagehide fire outside React's render cycle, so they'd
  // otherwise close over a stale first-render "idle"/null from the
  // effect's dependency array. Refs always read the latest value.
  const callRef = useRef<Call | null>(null);
  const phaseRef = useRef<Phase>("idle");
  useEffect(() => { callRef.current = call; }, [call]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ---- Request notification permission ----
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // ---- Reliably end the call if the tab/app closes mid-call ----
  // Without this, closing the tab (or the OS killing a backgrounded
  // browser) leaves the DB row stuck at 'ringing'/'active' forever,
  // which is what caused "Already on a call" to show up for every
  // future call and "call pic nahi hota" (Accept silently rejected
  // because the answerer already looked busy). A server-side trigger
  // now also auto-reaps stale rows as a safety net, but this fires
  // immediately instead of after the 45s/4h reap window, so the other
  // person sees the call end right away.
  useEffect(() => {
    const handleUnload = () => {
      const c = callRef.current;
      const p = phaseRef.current;
      if (!c) return;
      if (p === "incoming") {
        endCallBeacon(c.id, "missed");
      } else if (p === "outgoing") {
        endCallBeacon(c.id, "missed");
      } else if (p === "active") {
        endCallBeacon(c.id, "ended");
      }
    };
    window.addEventListener("pagehide", handleUnload);
    return () => window.removeEventListener("pagehide", handleUnload);
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

      // ---- Let the caller know it actually reached us (Ringing…) ----
      sendRingAck(incoming.id);

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
    ringAckUnsubRef.current();
    ringAckUnsubRef.current = () => {};
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
    setRingStatus("calling");
    respondingRef.current = false;
    setResponding(false);
  };

  // ---- Begin Active Call ----
  const beginActiveCall = async (activeCall: Call, isCaller: boolean) => {
    setPhase("active");

    // ---- Reliable hangup detection ----
    callRowUnsubRef.current = subscribeToCallRow(activeCall.id, (updated) => {
      if (updated.status === "ended" || updated.status === "missed" || updated.status === "declined") {
        resetToIdle();
      }
    });

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

    const prevNegotiationHandler = pc.onnegotiationneeded;
    pc.onnegotiationneeded = async (ev) => {
      if (prevNegotiationHandler) {
        try {
          await (prevNegotiationHandler as (this: RTCPeerConnection, ev: Event) => any).call(pc, ev);
        } catch (err) {
          console.warn("Prior negotiationneeded handler failed:", err);
        }
      }

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
    if (phase !== "idle" || startingCallRef.current) return;
    if (!callingIsSupported()) {
      setMediaError("Is browser/device pe calling support nahi hai.");
      return;
    }
    startingCallRef.current = true;

    try {
      const created = await createCall(conversationId, me, kind);
      if (!created) {
        setMediaError("Call create nahi ho saki — dobara try karo.");
        startingCallRef.current = false;
        return;
      }
      setCall(created);
      setPeerLabel(label);
      setPhase("outgoing");
      setRingStatus("calling");
      startingCallRef.current = false;

      // ---- Flip "Calling…" -> "Ringing…" once the other device acks ----
      ringAckUnsubRef.current = subscribeToRingAck(created.id, () => {
        setRingStatus("ringing");
      });

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
      startingCallRef.current = false;
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
    if (!call || respondingRef.current) return;
    respondingRef.current = true;
    setResponding(true);
    try {
      const won = await claimCall(call.id, me);
      if (!won) {
        resetToIdle();
        return;
      }
      const fresh: Call = { ...call, status: "active", answered_by: me.id, answered_at: new Date().toISOString() };
      setCall(fresh);
      await beginActiveCall(fresh, false);
    } finally {
      respondingRef.current = false;
      setResponding(false);
    }
  };

  // ---- Decline incoming ----
  const declineIncoming = async () => {
    if (!call || respondingRef.current) return;
    respondingRef.current = true;
    setResponding(true);
    try {
      if (me.role === "customer") {
        await endCall(call, "declined", me);
      }
      resetToIdle();
    } finally {
      respondingRef.current = false;
      setResponding(false);
    }
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
        <IncomingCallBanner
          call={call}
          peerLabel={peerLabel}
          onAccept={acceptIncoming}
          onDecline={declineIncoming}
          busy={responding}
        />
      )}

      {(phase === "outgoing" || phase === "active") && call && (
        <CallScreen
          call={call}
          phase={phase}
          ringStatus={ringStatus}
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
