import React, { useEffect, useRef } from "react";
import { Phone, PhoneOff, Video } from "lucide-react";
import { Call } from "../lib/types";

interface IncomingCallBannerProps {
  call: Call;
  peerLabel: string;
  onAccept: () => void;
  onDecline: () => void;
}

/** Lightweight ringtone — a soft two-tone beep looped via Web Audio,
 *  no audio file needed. Stops automatically when the banner unmounts. */
function useRingtone() {
  const ctxRef = useRef<AudioContext | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    ctxRef.current = ctx;

    const beep = () => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    };

    beep();
    intervalRef.current = setInterval(beep, 1500);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      ctx.close().catch(() => {});
    };
  }, []);
}

export default function IncomingCallBanner({ call, peerLabel, onAccept, onDecline }: IncomingCallBannerProps) {
  useRingtone();

  return (
    <div className="fixed inset-x-0 top-0 z-[60] px-3 pt-3">
      <div className="max-w-sm mx-auto bg-slate-900 border border-slate-700 rounded-2xl shadow-xl px-4 py-3 flex items-center gap-3">
        <div className="w-11 h-11 rounded-full bg-brand/20 text-brand flex items-center justify-center shrink-0 animate-pulse">
          {call.kind === "video" ? <Video size={18} /> : <Phone size={18} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{peerLabel}</div>
          <div className="text-[11px] text-slate-400">
            Incoming {call.kind === "video" ? "video" : "voice"} call…
          </div>
        </div>
        <button
          onClick={onDecline}
          className="w-10 h-10 rounded-full bg-red-500 text-white flex items-center justify-center shrink-0"
          aria-label="Decline"
        >
          <PhoneOff size={16} />
        </button>
        <button
          onClick={onAccept}
          className="w-10 h-10 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0"
          aria-label="Accept"
        >
          <Phone size={16} />
        </button>
      </div>
    </div>
  );
}
