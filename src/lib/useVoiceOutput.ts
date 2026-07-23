// ============================================================
//  useVoiceOutput — shared text-to-speech hook (Web Speech
//  Synthesis API). Used by the admin floating AI assistant so it
//  can speak its replies out loud, Siri/Alexa-style.
//
//  Browser support: Chrome/Edge (desktop + Android) — good.
//  Safari/iOS has its own voice list but generally works too.
//  Degrades gracefully (isSupported=false) if unavailable.
//
//  SELF-HEALING BY DESIGN:
//  1. Stale-closure fix — speak() reads voiceEnabled from a ref that's
//     always current, so voice never silently "forgets" it was turned on.
//  2. Retry-until-it-actually-speaks — Android Chrome sometimes silently
//     drops a speak() call: no error, no event, nothing. Every attempt
//     has a watchdog: if `onstart` doesn't fire in time, the engine is
//     assumed jammed, reset, and the same text retried (with backoff)
//     instead of silently giving up.
//  3. If all retries are exhausted, a toast is shown instead of failing
//     silently (common causes at that point are device-side: muted
//     media volume, missing TTS voice pack, background tab audio focus).
//  4. Long replies are split into short sentence-sized chunks and spoken
//     as a chain of utterances — keeps every individual utterance well
//     under the ~15s auto-pause bug some Android builds have.
// ============================================================
import { useEffect, useRef, useState, useCallback } from "react";
import { toastError } from "./toast";

interface UseVoiceOutputOptions {
  lang?: string;
  rate?: number; // 0.1–10, 1 = normal speed
  pitch?: number; // 0–2, 1 = normal
}

interface UseVoiceOutputReturn {
  isSupported: boolean;
  isSpeaking: boolean;
  voiceEnabled: boolean;
  toggleVoiceEnabled: () => void;
  speak: (text: string) => void;
  stopSpeaking: () => void;
  // Speaks immediately, ignoring the voiceEnabled gate. Only meant to be
  // called directly inside a click handler (e.g. the "Voice on" toggle
  // button) — Android Chrome blocks speechSynthesis calls that happen
  // after an async gap (like a fetch response), so this "primes" the
  // audio engine with a real user-gesture-linked call first.
  speakUnlocked: (text: string) => void;
}

const PRE_SPEAK_DELAY_MS = 150;   // let cancel() actually clear before speaking again
const START_TIMEOUT_MS = 1800;    // how long to wait for onstart before assuming it silently failed
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;  // backoff step between retries
const KEEPALIVE_INTERVAL_MS = 12000;
const MAX_CHUNK_CHARS = 140;

function splitIntoChunks(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const sentences = clean
    .split(/(?<=[.!?۔])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  const pushHardSplit = (piece: string) => {
    let rest = piece;
    while (rest.length > MAX_CHUNK_CHARS) {
      let cut = rest.lastIndexOf(" ", MAX_CHUNK_CHARS);
      if (cut <= 0) cut = MAX_CHUNK_CHARS;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    return rest;
  };

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= MAX_CHUNK_CHARS) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    current = pushHardSplit(sentence);
  }
  if (current) chunks.push(current);

  return chunks.length ? chunks : [clean];
}

export function useVoiceOutput({
  lang = "en-US",
  rate = 1,
  pitch = 1,
}: UseVoiceOutputOptions = {}): UseVoiceOutputReturn {
  const [isSupported, setIsSupported] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  const voiceEnabledRef = useRef(false);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const langRef = useRef(lang);
  const rateRef = useRef(rate);
  const pitchRef = useRef(pitch);

  const requestIdRef = useRef(0);
  const attemptCountRef = useRef(0);
  const startedRef = useRef(false);
  const attemptSettledRef = useRef(false);
  const preSpeakTimerRef = useRef<number | null>(null);
  const watchdogTimerRef = useRef<number | null>(null);
  const keepAliveTimerRef = useRef<number | null>(null);

  const queueRef = useRef<string[]>([]);
  const chunkIndexRef = useRef(0);
  const speakNextChunkRef = useRef<(myRequestId: number) => void>(() => {});

  useEffect(() => { voiceEnabledRef.current = voiceEnabled; }, [voiceEnabled]);
  useEffect(() => { langRef.current = lang; }, [lang]);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  useEffect(() => { pitchRef.current = pitch; }, [pitch]);

  const clearAllTimers = () => {
    if (preSpeakTimerRef.current) { window.clearTimeout(preSpeakTimerRef.current); preSpeakTimerRef.current = null; }
    if (watchdogTimerRef.current) { window.clearTimeout(watchdogTimerRef.current); watchdogTimerRef.current = null; }
    if (keepAliveTimerRef.current) { window.clearInterval(keepAliveTimerRef.current); keepAliveTimerRef.current = null; }
  };

  useEffect(() => {
    if (!("speechSynthesis" in window)) {
      setIsSupported(false);
      return;
    }
    setIsSupported(true);

    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      const l = langRef.current;
      const exact = voices.find((v) => v.lang.toLowerCase() === l.toLowerCase());
      const family = voices.find((v) => v.lang.toLowerCase().startsWith(l.slice(0, 2).toLowerCase()));
      voiceRef.current = exact || family || voices[0];
    };

    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;

    return () => {
      window.speechSynthesis.onvoiceschanged = null;
      clearAllTimers();
      window.speechSynthesis.cancel();
    };
  }, []);

  const hardStop = useCallback(() => {
    requestIdRef.current += 1; // invalidates any attempt/retry still in flight
    clearAllTimers();
    attemptCountRef.current = 0;
    startedRef.current = false;
    queueRef.current = [];
    chunkIndexRef.current = 0;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setIsSpeaking(false);
  }, []);

  const stopSpeaking = useCallback(() => {
    hardStop();
  }, [hardStop]);

  const attemptSpeak = useCallback((text: string, myRequestId: number) => {
    if (myRequestId !== requestIdRef.current) return;

    attemptCountRef.current += 1;
    startedRef.current = false;
    attemptSettledRef.current = false;

    window.speechSynthesis.cancel();

    preSpeakTimerRef.current = window.setTimeout(() => {
      if (myRequestId !== requestIdRef.current) return;

      const utterance = new SpeechSynthesisUtterance(text);
      if (voiceRef.current) {
        utterance.voice = voiceRef.current;
        // Use the voice's OWN lang, not the requested option — if the
        // requested language isn't installed on this device, pickVoice()
        // already fell back to whatever IS installed. Keeping them in
        // sync avoids a mismatch that some Android builds mishandle.
        utterance.lang = voiceRef.current.lang;
      } else {
        utterance.lang = langRef.current;
      }
      utterance.rate = rateRef.current;
      utterance.pitch = pitchRef.current;

      utterance.onstart = () => {
        if (myRequestId !== requestIdRef.current) return;
        startedRef.current = true;
        setIsSpeaking(true);

        if (keepAliveTimerRef.current) window.clearInterval(keepAliveTimerRef.current);
        keepAliveTimerRef.current = window.setInterval(() => {
          if (myRequestId !== requestIdRef.current || !window.speechSynthesis.speaking) {
            if (keepAliveTimerRef.current) { window.clearInterval(keepAliveTimerRef.current); keepAliveTimerRef.current = null; }
            return;
          }
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();

          window.setTimeout(() => {
            if (myRequestId !== requestIdRef.current) return;
            if (!window.speechSynthesis.speaking && !attemptSettledRef.current) {
              attemptSettledRef.current = true;
              if (keepAliveTimerRef.current) { window.clearInterval(keepAliveTimerRef.current); keepAliveTimerRef.current = null; }
              scheduleRetryOrGiveUp(text, myRequestId);
            }
          }, 250);
        }, KEEPALIVE_INTERVAL_MS);
      };

      utterance.onend = () => {
        if (myRequestId !== requestIdRef.current) return;
        attemptSettledRef.current = true;
        clearAllTimers();
        chunkIndexRef.current += 1;
        if (chunkIndexRef.current < queueRef.current.length) {
          attemptCountRef.current = 0;
          speakNextChunkRef.current(myRequestId);
        } else {
          setIsSpeaking(false);
          attemptCountRef.current = 0;
        }
      };

      utterance.onerror = () => {
        if (myRequestId !== requestIdRef.current) return;
        if (attemptSettledRef.current) return;
        attemptSettledRef.current = true;
        setIsSpeaking(false);
        clearAllTimers();
        scheduleRetryOrGiveUp(text, myRequestId);
      };

      window.speechSynthesis.speak(utterance);

      watchdogTimerRef.current = window.setTimeout(() => {
        if (myRequestId !== requestIdRef.current) return;
        if (attemptSettledRef.current) return;
        if (!startedRef.current) {
          if ("speechSynthesis" in window && window.speechSynthesis.speaking) {
            startedRef.current = true;
            setIsSpeaking(true);
            return;
          }
          attemptSettledRef.current = true;
          scheduleRetryOrGiveUp(text, myRequestId);
        }
      }, START_TIMEOUT_MS);
    }, PRE_SPEAK_DELAY_MS);
  }, []);

  const scheduleRetryOrGiveUp = useCallback((text: string, myRequestId: number) => {
    if (myRequestId !== requestIdRef.current) return;
    if (attemptCountRef.current >= MAX_ATTEMPTS) {
      toastError("Voice out nahi ho saka — device ka media volume aur Text-to-Speech voice pack check karein.");
      setIsSpeaking(false);
      attemptCountRef.current = 0;
      queueRef.current = [];
      chunkIndexRef.current = 0;
      return;
    }
    const delay = RETRY_BASE_DELAY_MS * attemptCountRef.current; // 250, 500, 750...
    window.setTimeout(() => attemptSpeak(text, myRequestId), delay);
  }, [attemptSpeak]);

  const speakNextChunk = useCallback((myRequestId: number) => {
    if (myRequestId !== requestIdRef.current) return;
    const chunk = queueRef.current[chunkIndexRef.current];
    if (chunk === undefined) {
      setIsSpeaking(false);
      return;
    }
    attemptSpeak(chunk, myRequestId);
  }, [attemptSpeak]);

  useEffect(() => { speakNextChunkRef.current = speakNextChunk; }, [speakNextChunk]);

  const speakInternal = useCallback((text: string) => {
    if (!isSupported || !text?.trim()) return;
    requestIdRef.current += 1;
    const myRequestId = requestIdRef.current;
    clearAllTimers();
    attemptCountRef.current = 0;
    queueRef.current = splitIntoChunks(text);
    chunkIndexRef.current = 0;
    speakNextChunk(myRequestId);
  }, [isSupported, speakNextChunk]);

  const speak = useCallback((text: string) => {
    if (!voiceEnabledRef.current) return;
    speakInternal(text);
  }, [speakInternal]);

  // No voiceEnabled gate — call ONLY from inside a direct click handler.
  const speakUnlocked = useCallback((text: string) => {
    speakInternal(text);
  }, [speakInternal]);

  const toggleVoiceEnabled = useCallback(() => {
    setVoiceEnabled((v) => {
      const next = !v;
      voiceEnabledRef.current = next;
      if (!next) hardStop();
      return next;
    });
  }, [hardStop]);

  return { isSupported, isSpeaking, voiceEnabled, toggleVoiceEnabled, speak, stopSpeaking, speakUnlocked };
}
