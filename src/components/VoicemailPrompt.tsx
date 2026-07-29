// ============================================================
//  src/components/VoicemailPrompt.tsx
//  PHASE 10: Voicemail
//  Shown to the CALLER only, after a ring times out unanswered — same
//  full-screen dark treatment as CallScreen so it reads as a natural
//  continuation of the call rather than a jarring context switch.
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import { Mic, Square, Send, X, User } from "lucide-react";

type VoicemailStage = "prompt" | "recording" | "recorded" | "sending";

interface VoicemailPromptProps {
  peerLabel: string;
  stage: VoicemailStage;
  seconds: number;
  previewUrl: string | null;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onSend: () => void;
  /** Also doubles as "skip" from the prompt stage and "re-record" cancel from the recorded stage. */
  onDiscard: () => void;
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function VoicemailPrompt({
  peerLabel,
  stage,
  seconds,
  previewUrl,
  onStartRecording,
  onStopRecording,
  onSend,
  onDiscard,
}: VoicemailPromptProps) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    setPlaying(false);
  }, [previewUrl]);

  const togglePreviewPlayback = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      el.play().catch(() => {});
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-slate-950 flex flex-col items-center justify-center px-6 gap-6">
      <div className="w-24 h-24 rounded-full bg-brand/20 text-brand flex items-center justify-center">
        <User size={40} />
      </div>
      <div className="text-center">
        <div className="text-lg font-semibold text-white">{peerLabel}</div>
        <div className="text-sm text-slate-400 mt-1">Koi jawab nahi mila</div>
      </div>

      {stage === "prompt" && (
        <div className="flex flex-col items-center gap-4 mt-4">
          <p className="text-sm text-slate-400 text-center max-w-xs">
            Voice message chhodain, taake {peerLabel} baad mein sun sakein.
          </p>
          <div className="flex items-center gap-5">
            <button
              onClick={onDiscard}
              className="w-14 h-14 rounded-full bg-slate-800 text-white flex items-center justify-center hover:bg-slate-700 transition"
              aria-label="Skip"
            >
              <X size={20} />
            </button>
            <button
              onClick={onStartRecording}
              className="w-16 h-16 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition shadow-lg shadow-red-500/30"
              aria-label="Record voicemail"
            >
              <Mic size={24} />
            </button>
          </div>
        </div>
      )}

      {stage === "recording" && (
        <div className="flex flex-col items-center gap-4 mt-4">
          <div className="flex items-center gap-2 text-red-400 text-sm font-medium">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            Recording… {formatDuration(seconds)}
          </div>
          <button
            onClick={onStopRecording}
            className="w-16 h-16 rounded-full bg-slate-800 text-white flex items-center justify-center hover:bg-slate-700 transition"
            aria-label="Stop and review"
          >
            <Square size={22} />
          </button>
        </div>
      )}

      {stage === "recorded" && (
        <div className="flex flex-col items-center gap-4 mt-4 w-full max-w-xs">
          {previewUrl && (
            <audio
              ref={audioRef}
              src={previewUrl}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              className="hidden"
            />
          )}
          <button
            onClick={togglePreviewPlayback}
            className="text-sm text-brand font-medium underline"
          >
            {playing ? "Pause" : "Sun kar dekhein"} ({formatDuration(seconds)})
          </button>
          <div className="flex items-center gap-5">
            <button
              onClick={onDiscard}
              className="w-14 h-14 rounded-full bg-slate-800 text-white flex items-center justify-center hover:bg-slate-700 transition"
              aria-label="Cancel"
            >
              <X size={20} />
            </button>
            <button
              onClick={onSend}
              className="w-16 h-16 rounded-full bg-success text-white flex items-center justify-center hover:bg-success/80 transition shadow-lg"
              aria-label="Send voicemail"
            >
              <Send size={22} />
            </button>
          </div>
        </div>
      )}

      {stage === "sending" && (
        <div className="flex flex-col items-center gap-3 mt-4 text-slate-400 text-sm">
          <div className="w-6 h-6 border-2 border-slate-600 border-t-brand rounded-full animate-spin" />
          Bhej rahe hain…
        </div>
      )}
    </div>
  );
}
