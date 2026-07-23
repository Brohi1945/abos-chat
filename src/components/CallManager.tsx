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
import { createPeerConnection, getLocalStream, stopStream, callingIsSupported } from "../lib/webrtc";
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

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const signalRef = useRef<ReturnType<typeof openCallSignalChannel> | null>(null);
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callRowUnsubRef = useRef<() => void>(() => {});
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

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
  };

  const resetToIdle = () => {
    cleanupMedia();
    setCall(null);
    setPeerLabel("");
    setPhase("idle");
    setMuted(false);
    setCameraOff(false);
  };

  const beginActiveCall = async (activeCall: Call, isCaller: boolean) => {
    setPhase("active");

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

    const pc = createPeerConnection({
      onRemoteStream: (s) => setRemoteStream(s),
      onIceCandidate: (candidate) => signalRef.current?.send({ type: "ice-candidate", candidate, from: me.id }),
    });
    pcRef.current = pc;
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
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signal.send({ type: "offer", sdp: offer, from: me.id });
    }
  };

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

  // safety cleanup if the whole app unmounts mid-call
  useEffect(() => () => cleanupMedia(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <CallContext.Provider value={{ startCall }}>
      {children}

      {mediaError && (
        <div className="fixed inset-x-0 top-3 z-[80] flex justify-center px-3">
          <div className="bg-danger/90 text-white text-xs font-medium px-4 py-2 rounded-full shadow-lg">
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
        />
      )}
    </CallContext.Provider>
  );
}
