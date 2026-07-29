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
  tuneOpusAudio,
  requestWakeLock,
  releaseWakeLock,
  setupWakeLockAutoRenew,
  cleanupWakeLockAutoRenew,
  stopQualityMonitoring,
  CallQualityReport,
  isScreenShareSupported,
  getScreenStream,
  getSupportedAudioMimeType,
  audioExtensionForMimeType,
} from "../lib/webrtc";
import { sendMessage, uploadMedia, staffIdentity } from "../lib/chatApi";
import IncomingCallBanner from "./IncomingCallBanner";
import CallScreen from "./CallScreen";
import VoicemailPrompt from "./VoicemailPrompt";

interface CallContextValue {
  startCall: (conversationId: string, kind: CallKind, peerLabel: string) => void;
  // Exposed so components like AdminAssistant can go quiet the instant
  // a call starts (see the "callInProgress" checks in AdminAssistant.tsx).
  // NOTE: this was missing before — AdminAssistant destructured `phase`
  // from this context but it was never actually provided, so it read as
  // `undefined` and `undefined !== "idle"` was always true, meaning the
  // floating assistant bubble treated a call as permanently "in progress"
  // and never rendered at all. Adding it here is the fix.
  phase: Phase;
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

// "voicemail": caller-side only — ring timed out unanswered, caller gets
// the option to leave a recorded message (Phase 10).
type Phase = "idle" | "outgoing" | "incoming" | "active" | "voicemail";
type RingStatus = "calling" | "ringing";
type VoicemailStage = "prompt" | "recording" | "recorded" | "sending";

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
  // ---- PHASE 10: Screen sharing ----
  const [screenSharing, setScreenSharing] = useState(false);
  const [peerScreenSharing, setPeerScreenSharing] = useState(false);
  // ---- PHASE 10: Call recording ----
  const [recording, setRecording] = useState(false);
  const [peerRecording, setPeerRecording] = useState(false);
  // ---- PHASE 10: Voicemail ----
  const [voicemailStage, setVoicemailStage] = useState<VoicemailStage>("prompt");
  const [voicemailSeconds, setVoicemailSeconds] = useState(0);
  const [voicemailPreviewUrl, setVoicemailPreviewUrl] = useState<string | null>(null);
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

  // ---- PHASE 10: Screen sharing refs ----
  // screenStreamRef holds the getDisplayMedia() stream so its tracks can
  // be stopped (releases the browser's "sharing" indicator) on toggle-off
  // or hangup. cameraTrackRef holds the ORIGINAL camera track captured at
  // call start, so stopping screen share can restore it via
  // replaceTrack() — the whole point of using replaceTrack() over
  // addTrack()/renegotiation is that it needs no new offer/answer, so it
  // can't reopen the double-offer bug that was just fixed above.
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);

  // ---- PHASE 10: Call recording refs ----
  // recordingAudioCtxRef mixes local mic + remote peer audio into one
  // MediaStreamDestination so a single MediaRecorder captures both sides
  // of the conversation — video is NOT recorded (audio-only), see the
  // notes on startRecording() below for why.
  const recordingRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingAudioCtxRef = useRef<AudioContext | null>(null);
  // Captured at recording-start time rather than read from `call` state
  // when the recorder finally stops — resetToIdle() clears `call` to null
  // as soon as the hangup happens, which could otherwise race with the
  // recorder's async onstop upload finishing afterwards.
  const recordingCallSnapshotRef = useRef<Call | null>(null);

  // ---- PHASE 10: Voicemail refs ----
  const voicemailRecorderRef = useRef<MediaRecorder | null>(null);
  const voicemailChunksRef = useRef<Blob[]>([]);
  const voicemailBlobRef = useRef<Blob | null>(null);
  const voicemailMimeRef = useRef<string>("audio/webm");
  const voicemailTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const voicemailPromptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voicemailCallSnapshotRef = useRef<Call | null>(null);

  // ---- Keep a live snapshot of call/phase for the unload handler ----
  // beforeunload/pagehide fire outside React's render cycle, so they'd
  // otherwise close over a stale first-render "idle"/null from the
  // effect's dependency array. Refs always read the latest value.
  const callRef = useRef<Call | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const voicemailStageRef = useRef<VoicemailStage>("prompt");
  useEffect(() => { callRef.current = call; }, [call]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { voicemailStageRef.current = voicemailStage; }, [voicemailStage]);

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

    // ---- PHASE 10: Screen sharing cleanup ----
    // Stopping the tracks (not just dropping the reference) is what
    // actually turns off the browser's "sharing your screen" indicator —
    // otherwise it stays on until the whole tab closes.
    stopStream(screenStreamRef.current);
    screenStreamRef.current = null;
    cameraTrackRef.current = null;
    setScreenSharing(false);
    setPeerScreenSharing(false);

    // ---- PHASE 10: Call recording cleanup ----
    // Defensive net only — the normal paths (hangup, peer-hangup, toggle
    // off) already call recorder.stop() themselves so the recording gets
    // uploaded. This just guarantees the mic-mixing AudioContext never
    // leaks if something ends the call in an unexpected way.
    if (recordingRef.current && recordingRef.current.state !== "inactive") {
      try {
        recordingRef.current.stop();
      } catch {
        // ignore
      }
    }
    recordingRef.current = null;
    recordingChunksRef.current = [];
    if (recordingAudioCtxRef.current) {
      recordingAudioCtxRef.current.close().catch(() => {});
      recordingAudioCtxRef.current = null;
    }
    setRecording(false);
    setPeerRecording(false);

    // ---- PHASE 10: Voicemail cleanup ----
    if (voicemailRecorderRef.current && voicemailRecorderRef.current.state !== "inactive") {
      try {
        voicemailRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    voicemailRecorderRef.current = null;
    voicemailChunksRef.current = [];
    voicemailBlobRef.current = null;
    if (voicemailTimerRef.current) {
      clearInterval(voicemailTimerRef.current);
      voicemailTimerRef.current = null;
    }
    if (voicemailPromptTimeoutRef.current) {
      clearTimeout(voicemailPromptTimeoutRef.current);
      voicemailPromptTimeoutRef.current = null;
    }
    setVoicemailPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setVoicemailStage("prompt");
    setVoicemailSeconds(0);

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
        // If WE were recording, finish and upload it before tearing the
        // call down — otherwise resetToIdle()->cleanupMedia() would just
        // discard whatever's buffered in the recorder.
        if (recordingRef.current && recordingRef.current.state !== "inactive") {
          recordingRef.current.stop();
        }
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
    console.log("[DEBUG] Local stream captured. audio tracks:", stream.getAudioTracks().length, "video tracks:", stream.getVideoTracks().length);
    // PHASE 10: remember the real camera track so screen-share can be
    // reverted later via replaceTrack() — see screenStreamRef notes above.
    cameraTrackRef.current = stream.getVideoTracks()[0] || null;

    const pc = await createPeerConnection({
      onRemoteStream: (s) => {
        console.log("[DEBUG] Remote stream received. audio tracks:", s.getAudioTracks().length, "video tracks:", s.getVideoTracks().length);
        s.getAudioTracks().forEach((t) => console.log("[DEBUG] remote audio track — enabled:", t.enabled, "muted:", t.muted, "readyState:", t.readyState));
        setRemoteStream(s);
      },
      onIceCandidate: (candidate) => signalRef.current?.send({ type: "ice-candidate", candidate, from: me.id }),

      onIceConnectionStateChange: (state) => {
        console.log("[DEBUG] ICE connection state:", state);
        // NOTE: `phase` here is a snapshot from the render that was active
        // when beginActiveCall() was invoked — it never updates inside this
        // closure, so it was permanently stuck on "outgoing"/"incoming" and
        // this whole reconnect path was silently dead code. phaseRef always
        // reads the live value, so use that instead.
        if (phaseRef.current !== "active") return;
        if (state === "disconnected" || state === "failed") {
          if (restartAttemptedRef.current) return;
          restartAttemptedRef.current = true;

          if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
          restartTimeoutRef.current = setTimeout(() => {
            if (phaseRef.current !== "active") return;
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
            ? '⚠️ Connection very weak — video quality lowered automatically'
            : '⚠️ Connection weak — video quality adjusted automatically';
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
        offer.sdp = tuneOpusAudio(offer.sdp || "");
        await pc.setLocalDescription(offer);
        signalRef.current?.send({ type: "offer", sdp: offer, from: me.id });
      } catch (err) {
        console.error("Negotiation needed failed:", err);
      } finally {
        isNegotiatingRef.current = false;
      }
    };

    stream.getTracks().forEach((t) => {
      pc.addTrack(t, stream);
      console.log("[DEBUG] Added local track to pc:", t.kind, "enabled:", t.enabled);
    });

    const signal = openCallSignalChannel(activeCall.id, me.id, async (msg: SignalMessage) => {
      if (msg.type === "offer") {
        await pc.setRemoteDescription(msg.sdp);
        for (const c of pendingIceRef.current) await pc.addIceCandidate(c);
        pendingIceRef.current = [];
        const answer = await pc.createAnswer();
        answer.sdp = tuneOpusAudio(answer.sdp || "");
        await pc.setLocalDescription(answer);
        signal.send({ type: "answer", sdp: answer, from: me.id });
      } else if (msg.type === "answer") {
        await pc.setRemoteDescription(msg.sdp);
        for (const c of pendingIceRef.current) await pc.addIceCandidate(c);
        pendingIceRef.current = [];
      } else if (msg.type === "ice-candidate") {
        if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
        else pendingIceRef.current.push(msg.candidate);
      } else if (msg.type === "screen-share") {
        // Pure status ping — no SDP involved, see SignalMessage note.
        setPeerScreenSharing(msg.active);
      } else if (msg.type === "recording-status") {
        setPeerRecording(msg.active);
      } else if (msg.type === "hangup") {
        // The side that hung up already ran the full endCall() (DB status
        // + profiles + call-log message). Doing it again here caused a
        // duplicate call-log entry and delayed our own cleanup behind an
        // extra DB round-trip. subscribeToCallRow (above) is still a
        // fallback in case this broadcast never arrives.
        resetToIdle();
      }
    });
    signalRef.current = signal;

    // NOTE: we used to also manually create+send an offer here for the
    // caller, right after addTrack(). But addTrack() ALSO fires the
    // browser's own "negotiationneeded" event (handled above), which does
    // the exact same thing. That meant the caller sent TWO offers back to
    // back on every call: the manual one immediately, then a second one a
    // moment later from onnegotiationneeded (isNegotiatingRef had already
    // been reset to false by the time it fired). The callee would apply
    // the first offer, answer it, then get hit with an unexpected second
    // offer/renegotiation — this is what caused calls to "connect" (status
    // flips to active) but audio to never actually flow, or flow one-way.
    // The onnegotiationneeded handler above is enough on its own — it's
    // the standard, correct place for the caller to make the offer.
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
        ringTimeoutRef.current = null;
        // Unsubscribe BEFORE writing "missed" ourselves — otherwise our
        // own write echoes back through this same subscription a moment
        // later and its "declined/ended/missed" branch would immediately
        // call resetToIdle(), stomping the voicemail prompt we're about
        // to show.
        callRowUnsubRef.current();
        callRowUnsubRef.current = () => {};
        ringAckUnsubRef.current();
        ringAckUnsubRef.current = () => {};
        const missedCall = { ...created, status: "missed" as const };
        await endCall(created, "missed", me);
        startVoicemailPrompt(missedCall);
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
    // Finish the recording (uploads it) before tearing the call down —
    // stop() is queued async by the browser but recordingCallSnapshotRef
    // means the upload doesn't depend on `call` state still existing.
    if (recordingRef.current && recordingRef.current.state !== "inactive") {
      recordingRef.current.stop();
    }
    const status = phase === "active" ? "ended" : "missed";
    if (phase === "active") signalRef.current?.send({ type: "hangup", from: me.id });
    // NOTE: endCallBeacon() is intentionally NOT called here. It's a
    // fire-and-forget PATCH meant only for the pagehide/unload case (see
    // that handler above) where a full async endCall() might not finish
    // before the tab dies. Calling it here too raced with the full
    // endCall() write below — if the beacon's minimal PATCH landed first,
    // endCall()'s conditional UPDATE (.in("status", [...])) would no
    // longer match the row, silently skipping duration_seconds.
    await endCall(call, status, me);
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

  // ---- PHASE 10: Screen sharing ----
  // Deliberately uses RTCRtpSender.replaceTrack() on the existing video
  // m-line instead of addTrack()/a new transceiver — replaceTrack() swaps
  // the outgoing media on an already-negotiated line and needs NO new
  // offer/answer round trip. That matters here specifically because the
  // onnegotiationneeded handler above only lets the CALLER send offers
  // (isCaller check) — that's the fix for the double-offer/no-audio bug.
  // If screen share triggered a renegotiation from the callee's side, it
  // would hit that same guard and silently do nothing. replaceTrack()
  // sidesteps the whole problem and works identically for either side.
  const stopScreenShare = async () => {
    const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === "video");
    if (sender && cameraTrackRef.current) {
      try {
        await sender.replaceTrack(cameraTrackRef.current);
      } catch (err) {
        console.warn("Failed to restore camera track after screen share:", err);
      }
    }
    stopStream(screenStreamRef.current);
    screenStreamRef.current = null;
    setScreenSharing(false);
    signalRef.current?.send({ type: "screen-share", active: false, from: me.id });
  };

  const startScreenShare = async () => {
    if (!pcRef.current || call?.kind !== "video" || phase !== "active") return;
    try {
      const stream = await getScreenStream();
      const screenTrack = stream.getVideoTracks()[0];
      if (!screenTrack) return;

      const sender = pcRef.current.getSenders().find((s) => s.track?.kind === "video");
      if (sender) {
        await sender.replaceTrack(screenTrack);
      }

      screenStreamRef.current = stream;
      // Browser's own "Stop sharing" bar/dialog ends the track directly —
      // this catches that path too, not just our own toggle button.
      screenTrack.onended = () => {
        stopScreenShare();
      };

      setScreenSharing(true);
      signalRef.current?.send({ type: "screen-share", active: true, from: me.id });
    } catch (err) {
      // User cancelled the OS picker or denied permission — not an error
      // worth surfacing as a toast, this is a normal outcome.
      console.debug("Screen share not started:", err);
    }
  };

  const toggleScreenShare = () => {
    if (screenSharing) void stopScreenShare();
    else void startScreenShare();
  };

  // ---- PHASE 10: Call recording ----
  // Audio-only by design: mixes local mic + remote peer audio through a
  // Web Audio AudioContext into one MediaStreamDestination, so a single
  // MediaRecorder captures both sides of the conversation as one file.
  // Video is deliberately NOT captured — doing that reliably needs a
  // canvas-compositing loop (draw both video elements to canvas every
  // frame, captureStream() it, mux with the audio) which is a much
  // bigger, more fragile piece of work for the "training/support
  // reference" use case this is meant for, where the audio is what
  // actually matters. Can be layered on later if video is ever needed.
  const startRecording = async () => {
    if (!call || phase !== "active" || !localStream) return;
    if (!window.MediaRecorder) {
      setMediaError("Recording is browser pe support nahi hai.");
      return;
    }
    const mimeType = getSupportedAudioMimeType();
    if (!mimeType) {
      setMediaError("Recording format is device pe supported nahi.");
      return;
    }

    // Consent notice — the OTHER party also gets a live "recording"
    // banner the instant this starts (via the signal below), but the
    // person actually pressing record gets an explicit heads-up too.
    const confirmed = window.confirm(
      "Yeh call record hogi aur dusri party ko bhi notice mil jayega. Recording shuru karein?"
    );
    if (!confirmed) return;

    try {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new AudioCtxClass();
      const dest = ctx.createMediaStreamDestination();

      const localAudioTracks = localStream.getAudioTracks();
      if (localAudioTracks.length > 0) {
        ctx.createMediaStreamSource(new MediaStream(localAudioTracks)).connect(dest);
      }
      const remoteAudioTracks = remoteStream?.getAudioTracks() || [];
      if (remoteAudioTracks.length > 0) {
        ctx.createMediaStreamSource(new MediaStream(remoteAudioTracks)).connect(dest);
      }

      const recordingCall = call; // snapshot — see recordingCallSnapshotRef note
      recordingCallSnapshotRef.current = recordingCall;

      const recorder = new MediaRecorder(dest.stream, { mimeType });
      recordingChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        ctx.close().catch(() => {});
        if (recordingAudioCtxRef.current === ctx) recordingAudioCtxRef.current = null;

        const blob = new Blob(recordingChunksRef.current, { type: mimeType });
        recordingChunksRef.current = [];
        setRecording(false);
        signalRef.current?.send({ type: "recording-status", active: false, from: me.id });

        const targetCall = recordingCallSnapshotRef.current;
        if (blob.size === 0 || !targetCall) return;

        const ext = audioExtensionForMimeType(mimeType);
        const url = await uploadMedia(blob, `conversations/${targetCall.conversation_id}/recordings`, ext);
        if (url) {
          const senderRole: "customer" | "owner" = me.role === "customer" ? "customer" : "owner";
          await sendMessage({
            conversationId: targetCall.conversation_id,
            senderId: me.id,
            senderRole,
            kind: "recording",
            mediaUrl: url,
            body: "🔴 Call recording",
            callId: targetCall.id,
            ...staffIdentity(me),
          });
        }
      };

      recordingRef.current = recorder;
      recordingAudioCtxRef.current = ctx;
      recorder.start();
      setRecording(true);
      signalRef.current?.send({ type: "recording-status", active: true, from: me.id });
    } catch (err) {
      console.warn("Failed to start recording:", err);
      setMediaError("Recording start nahi ho saki.");
    }
  };

  const stopRecording = () => {
    if (recordingRef.current && recordingRef.current.state !== "inactive") {
      recordingRef.current.stop();
    }
  };

  const toggleRecording = () => {
    if (recording) stopRecording();
    else void startRecording();
  };

  // ---- PHASE 10: Voicemail ----
  // Only reachable from the ring-timeout path in startCall() — caller's
  // side only, after the callee genuinely never answered.
  const startVoicemailPrompt = (missedCall: Call) => {
    voicemailCallSnapshotRef.current = missedCall;
    setCall(missedCall);
    setVoicemailStage("prompt");
    setVoicemailSeconds(0);
    setPhase("voicemail");

    // Don't leave the caller stuck on this screen forever if they just
    // walk away without deciding — 20s, then quietly go back to idle.
    voicemailPromptTimeoutRef.current = setTimeout(() => {
      if (voicemailStageRef.current === "prompt") resetToIdle();
    }, 20000);
  };

  const startVoicemailRecording = async () => {
    if (voicemailPromptTimeoutRef.current) {
      clearTimeout(voicemailPromptTimeoutRef.current);
      voicemailPromptTimeoutRef.current = null;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setMediaError("Voice recording is browser pe support nahi hai.");
      return;
    }
    const mimeType = getSupportedAudioMimeType();
    if (!mimeType) {
      setMediaError("Recording format is device pe supported nahi.");
      return;
    }
    voicemailMimeRef.current = mimeType;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType });
      voicemailChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) voicemailChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (voicemailTimerRef.current) {
          clearInterval(voicemailTimerRef.current);
          voicemailTimerRef.current = null;
        }
        const blob = new Blob(voicemailChunksRef.current, { type: mimeType });
        voicemailChunksRef.current = [];
        if (blob.size === 0) {
          setVoicemailStage("prompt");
          return;
        }
        voicemailBlobRef.current = blob;
        setVoicemailPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        setVoicemailStage("recorded");
      };
      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        setMediaError("Recording mein masla hua, dobara try karo.");
        setVoicemailStage("prompt");
      };

      voicemailRecorderRef.current = recorder;
      recorder.start();
      setVoicemailStage("recording");
      setVoicemailSeconds(0);
      voicemailTimerRef.current = setInterval(() => setVoicemailSeconds((s) => s + 1), 1000);
    } catch (err: any) {
      if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
        setMediaError("Microphone permission denied.");
      } else {
        setMediaError("Voicemail record nahi ho saki.");
      }
    }
  };

  const stopVoicemailRecording = () => {
    if (voicemailRecorderRef.current && voicemailRecorderRef.current.state !== "inactive") {
      voicemailRecorderRef.current.stop();
    }
  };

  const sendVoicemail = async () => {
    const targetCall = voicemailCallSnapshotRef.current;
    const blob = voicemailBlobRef.current;
    if (!targetCall || !blob) return;

    setVoicemailStage("sending");
    const ext = audioExtensionForMimeType(voicemailMimeRef.current);
    const url = await uploadMedia(blob, `conversations/${targetCall.conversation_id}/voicemail`, ext);
    if (url) {
      const senderRole: "customer" | "owner" = me.role === "customer" ? "customer" : "owner";
      await sendMessage({
        conversationId: targetCall.conversation_id,
        senderId: me.id,
        senderRole,
        kind: "voice",
        mediaUrl: url,
        body: "🎙️ Voicemail",
        callId: targetCall.id,
        ...staffIdentity(me),
      });
    } else {
      setMediaError("Voicemail bhejne mein masla hua.");
    }
    resetToIdle();
  };

  const discardVoicemail = () => {
    resetToIdle();
  };

  useEffect(() => {
    if (!mediaError) return;
    const id = setTimeout(() => setMediaError(""), 4000);
    return () => clearTimeout(id);
  }, [mediaError]);

  useEffect(() => () => cleanupMedia(), []);

  return (
    <CallContext.Provider value={{ startCall, phase }}>
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

      {phase === "voicemail" && call && (
        <VoicemailPrompt
          peerLabel={peerLabel}
          stage={voicemailStage}
          seconds={voicemailSeconds}
          previewUrl={voicemailPreviewUrl}
          onStartRecording={startVoicemailRecording}
          onStopRecording={stopVoicemailRecording}
          onSend={sendVoicemail}
          onDiscard={discardVoicemail}
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
          screenSharing={screenSharing}
          peerScreenSharing={peerScreenSharing}
          onToggleScreenShare={toggleScreenShare}
          screenShareSupported={isScreenShareSupported()}
          recording={recording}
          peerRecording={peerRecording}
          onToggleRecording={toggleRecording}
        />
      )}
    </CallContext.Provider>
  );
}
