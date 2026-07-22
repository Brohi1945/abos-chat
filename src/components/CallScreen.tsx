import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, User } from "lucide-react";
import { Call } from "../lib/types";

interface CallScreenProps {
  call: Call;
  phase: "outgoing" | "active";
  peerLabel: string;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onHangup: () => void;
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
  peerLabel,
  localStream,
  remoteStream,
  muted,
  cameraOff,
  onToggleMute,
  onToggleCamera,
  onHangup,
}: CallScreenProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const elapsed = useElapsedSeconds(phase === "active" ? call.answered_at : null);
  const isVideo = call.kind === "video";

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (isVideo && remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
    if (!isVideo && remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;
  }, [remoteStream, isVideo]);

  return (
    <div className="fixed inset-0 z-[70] bg-slate-950 flex flex-col">
      {!isVideo && <audio ref={remoteAudioRef} autoPlay />}

      {/* Video / avatar area */}
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
                {phase === "outgoing" ? "Ringing…" : "Connecting…"}
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
            <div className="text-lg font-semibold">{peerLabel}</div>
            <div className="text-sm text-slate-400">
              {phase === "outgoing" ? "Ringing…" : formatDuration(elapsed)}
            </div>
          </div>
        )}

        {isVideo && (
          <div className="absolute top-4 left-4 bg-black/40 rounded-full px-3 py-1.5 text-xs font-medium">
            {peerLabel} · {phase === "outgoing" ? "Ringing…" : formatDuration(elapsed)}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="p-6 flex items-center justify-center gap-5 shrink-0">
        <button
          onClick={onToggleMute}
          disabled={phase !== "active"}
          className={`w-14 h-14 rounded-full flex items-center justify-center disabled:opacity-40 ${
            muted ? "bg-white text-slate-900" : "bg-slate-800 text-white"
          }`}
        >
          {muted ? <MicOff size={20} /> : <Mic size={20} />}
        </button>

        {isVideo && (
          <button
            onClick={onToggleCamera}
            disabled={phase !== "active"}
            className={`w-14 h-14 rounded-full flex items-center justify-center disabled:opacity-40 ${
              cameraOff ? "bg-white text-slate-900" : "bg-slate-800 text-white"
            }`}
          >
            {cameraOff ? <VideoOff size={20} /> : <Video size={20} />}
          </button>
        )}

        <button
          onClick={onHangup}
          className="w-16 h-16 rounded-full bg-red-500 text-white flex items-center justify-center"
          aria-label="Hang up"
        >
          <PhoneOff size={24} />
        </button>
      </div>
    </div>
  );
}
