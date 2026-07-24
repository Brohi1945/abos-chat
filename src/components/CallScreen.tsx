// ============================================================
//  src/components/CallScreen.tsx
//  Complete Call Screen — Phase 1 to 7
//  - Call controls
//  - Quality badge (Phase 3)
//  - Calling… / Ringing… status (WhatsApp-style)
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, User, Volume2, Wifi } from "lucide-react";
import { Call } from "../lib/types";
import { CallQualityReport } from "../lib/webrtc";

interface CallScreenProps {
  call: Call;
  phase: "outgoing" | "active";
  /** Only meaningful while phase === "outgoing". "calling" until the other
   *  device's IncomingCallBanner has actually mounted and acked back —
   *  if they have no network / app closed, this never flips and it just
   *  keeps showing "Calling…" until the ring times out, same as WhatsApp. */
  ringStatus?: "calling" | "ringing";
  peerLabel: string;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onHangup: () => void;
  qualityReport?: CallQualityReport | null;
}

function getQualityColor(quality: string): string {
  switch (quality) {
    case 'excellent': return 'bg-green-500';
    case 'good': return 'bg-cyan-500';
    case 'poor': return 'bg-yellow-500';
    case 'very-poor': return 'bg-red-500';
    default: return 'bg-slate-500';
  }
}

function getQualityLabel(quality: string): string {
  switch (quality) {
    case 'excellent': return 'Excellent';
    case 'good': return 'Good';
    case 'poor': return 'Weak';
    case 'very-poor': return 'Very Weak';
    default: return '--';
  }
}

function getWifiColor(quality: string): string {
  switch (quality) {
    case 'excellent': return 'text-green-400';
    case 'good': return 'text-cyan-400';
    case 'poor': return 'text-yellow-400';
    case 'very-poor': return 'text-red-400';
    default: return 'text-slate-400';
  }
}

function useElapsedSeconds(startAt: string | null) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!startAt) return;
    const start = new Date(startAt).getTime();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startAt]);
  return seconds;
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function CallScreen({
  call,
  phase,
  ringStatus = "calling",
  peerLabel,
  localStream,
  remoteStream,
  muted,
  cameraOff,
  onToggleMute,
  onToggleCamera,
  onHangup,
  qualityReport,
}: CallScreenProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const elapsed = useElapsedSeconds(phase === "active" ? call.answered_at : null);
  const isVideo = call.kind === "video";
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);

  // "Calling…" while we're waiting for proof it reached the other
  // device, "Ringing…" once it has (their phone/app is actually alerting
  // them now) — same distinction WhatsApp makes.
  const outgoingLabel = ringStatus === "ringing" ? "Ringing…" : "Calling…";

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    const el = isVideo ? remoteVideoRef.current : remoteAudioRef.current;
    if (!el) return;
    el.srcObject = remoteStream;
    if (!remoteStream) return;
    el.play()
      .then(() => setNeedsAudioUnlock(false))
      .catch(() => setNeedsAudioUnlock(true));
  }, [remoteStream, isVideo]);

  const unlockAudio = () => {
    const el = isVideo ? remoteVideoRef.current : remoteAudioRef.current;
    el?.play()
      .then(() => setNeedsAudioUnlock(false))
      .catch(() => {});
  };

  const showQuality = phase === "active" && qualityReport;
  const qualityColor = showQuality ? getQualityColor(qualityReport!.quality) : 'bg-slate-500';
  const qualityLabel = showQuality ? getQualityLabel(qualityReport!.quality) : '--';

  return (
    <div className="fixed inset-0 z-[70] bg-slate-950 flex flex-col">
      {!isVideo && <audio ref={remoteAudioRef} autoPlay />}

      {showQuality && (
        <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
          <div className="flex items-center gap-1.5 bg-black/60 backdrop-blur-sm rounded-full px-3 py-1.5 border border-white/10">
            <Wifi size={14} className={getWifiColor(qualityReport!.quality)} />
            <span className="text-[10px] text-white font-medium">
              {qualityLabel}
              {qualityReport!.packetLoss !== null && qualityReport!.packetLoss > 0 && (
                <span className="text-slate-400 ml-1">· {qualityReport!.packetLoss}% loss</span>
              )}
              {qualityReport!.rtt !== null && qualityReport!.rtt > 0 && (
                <span className="text-slate-400 ml-1">· {Math.round(qualityReport!.rtt)}ms</span>
              )}
            </span>
            <span className={`w-1.5 h-1.5 rounded-full ${qualityColor} ml-0.5`} />
          </div>
        </div>
      )}

      <div className="flex-1 relative flex items-center justify-center overflow-hidden">
        {isVideo ? (
          <>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="absolute inset-0 w-full h-full object-cover bg-slate-900"
            />
            {!remoteStream && (
              <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
                {phase === "outgoing" ? outgoingLabel : "Connecting…"}
              </div>
            )}
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="absolute bottom-4 right-4 w-24 h-32 sm:w-28 sm:h-36 rounded-xl object-cover border-2 border-slate-700 bg-slate-800"
            />
          </>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="w-24 h-24 rounded-full bg-brand/20 text-brand flex items-center justify-center">
              <User size={40} />
            </div>
            <div className="text-lg font-semibold text-white">{peerLabel}</div>
            <div className="text-sm text-slate-400">
              {phase === "outgoing" ? outgoingLabel : formatDuration(elapsed)}
            </div>
          </div>
        )}

        {isVideo && (
          <div className="absolute top-4 left-4 bg-black/40 rounded-full px-3 py-1.5 text-xs font-medium text-white">
            {peerLabel} · {phase === "outgoing" ? outgoingLabel : formatDuration(elapsed)}
          </div>
        )}

        {needsAudioUnlock && (
          <button
            onClick={unlockAudio}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-amber-500 text-slate-900 text-xs font-semibold px-4 py-2 rounded-full shadow-lg animate-pulse"
          >
            <Volume2 size={14} />
            Awaz start karne ke liye tap karo
          </button>
        )}
      </div>

      <div className="p-6 flex items-center justify-center gap-5 shrink-0">
        <button
          onClick={onToggleMute}
          disabled={phase !== "active"}
          className={`w-14 h-14 rounded-full flex items-center justify-center disabled:opacity-40 transition ${
            muted ? "bg-white text-slate-900" : "bg-slate-800 text-white hover:bg-slate-700"
          }`}
        >
          {muted ? <MicOff size={20} /> : <Mic size={20} />}
        </button>

        {isVideo && (
          <button
            onClick={onToggleCamera}
            disabled={phase !== "active"}
            className={`w-14 h-14 rounded-full flex items-center justify-center disabled:opacity-40 transition ${
              cameraOff ? "bg-white text-slate-900" : "bg-slate-800 text-white hover:bg-slate-700"
            }`}
          >
            {cameraOff ? <VideoOff size={20} /> : <Video size={20} />}
          </button>
        )}

        <button
          onClick={onHangup}
          className="w-16 h-16 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition shadow-lg shadow-red-500/30"
          aria-label="Hang up"
        >
          <PhoneOff size={24} />
        </button>
      </div>
    </div>
  );
}
