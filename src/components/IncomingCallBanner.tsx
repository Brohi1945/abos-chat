import React, { useEffect } from "react";
import { Phone, PhoneOff, Video } from "lucide-react";
import { Call } from "../lib/types";

interface IncomingCallBannerProps {
  call: Call;
  peerLabel: string;
  onAccept: () => void;
  onDecline: () => void;
}

/** Ringtone — a classic "ring-ring… pause…" double-pulse pattern, like
 *  an actual phone call, looped via Web Audio (no audio file needed).
 *  Also vibrates the device in sync, on browsers that support it.
 *  Both stop automatically when the banner unmounts. */
function useRingtone() {
  useEffect(() => {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = AudioCtx ? new AudioCtx() : null;

    const playTone = (startOffset: number, duration: number) => {
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 950;
      const start = ctx.currentTime + startOffset;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.3, start + 0.05);
      gain.gain.setValueAtTime(0.3, start + duration - 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration);
    };

    const RING_CYCLE_MS = 3000;
    const ringCycle = () => {
      playTone(0, 0.4);
      playTone(0.5, 0.4);
      if (navigator.vibrate) navigator.vibrate([400, 100, 400]);
    };

    ringCycle();
    const interval = setInterval(ringCycle, RING_CYCLE_MS);

    return () => {
      clearInterval(interval);
      ctx?.close().catch(() => {});
      navigator.vibrate?.(0);
    };
  }, []);
}

export default function IncomingCallBanner({ call, peerLabel, onAccept, onDecline }: IncomingCallBannerProps) {
  useRingtone();

  return (
    <div className="fixed inset-x-0 top-0 z-[60] px-3 pt-3">
      <div className="max-w-sm mx-auto bg-surface border rounded-2xl shadow-xl px-4 py-3 flex items-center gap-3">
        <div className="w-11 h-11 rounded-full bg-brand/20 text-brand flex items-center justify-center shrink-0 animate-pulse">
          {call.kind === "video" ? <Video size={18} /> : <Phone size={18} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate text-fg">{peerLabel}</div>
          <div className="text-[11px] text-muted">
            Incoming {call.kind === "video" ? "video" : "voice"} call…
          </div>
        </div>
        <button
          onClick={onDecline}
          className="w-10 h-10 rounded-full bg-danger text-white flex items-center justify-center shrink-0"
          aria-label="Decline"
        >
          <PhoneOff size={16} />
        </button>
        <button
          onClick={onAccept}
          className="w-10 h-10 rounded-full bg-success text-white flex items-center justify-center shrink-0"
          aria-label="Accept"
        >
          <Phone size={16} />
        </button>
      </div>
    </div>
  );
}
