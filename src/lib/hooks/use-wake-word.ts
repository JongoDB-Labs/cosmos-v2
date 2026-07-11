"use client";
import { useEffect, useRef, useState } from "react";

interface WakeWordOptions {
  phrase: string; // case-insensitive substring to listen for, e.g. "hey cosmo"
  enabled: boolean;
  onWake: () => void;
}

export interface WakeWordStatus {
  /** Whether this browser ships the Web Speech API at all (Firefox doesn't). */
  supported: boolean;
  /** True while a recognition session is actively running (mic is live). */
  listening: boolean;
}

function detectSupport(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

/** Normalize recognizer output for matching: lowercase, strip punctuation
 *  (Chrome loves to transcribe "Hey, Cosmo." with a comma), collapse spaces. */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Loose wake matching (ported from the okr-dashboard reference, which matched
 *  bare "cosmos" + "a cosmos" variants): the full phrase matches after
 *  normalization, OR the phrase's distinctive last word appears as a word
 *  prefix — so "hey, cosmo.", "a cosmo", and "hey cosmos" all wake, while the
 *  recognizer's mangling of the leading "hey" never blocks it. */
export function matchesWakePhrase(transcript: string, phrase: string): boolean {
  const t = normalizeTranscript(transcript);
  const p = normalizeTranscript(phrase);
  if (!p) return false;
  if (t.includes(p)) return true;
  const words = p.split(" ");
  const distinctive = words[words.length - 1];
  // Only fall back to the single-word match when it's actually distinctive —
  // 4+ chars keeps "hey" / "ok" style words from waking on their own.
  if (distinctive.length < 4) return false;
  return new RegExp(`\\b${distinctive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t);
}

export function useWakeWord({
  phrase,
  enabled,
  onWake,
}: WakeWordOptions): WakeWordStatus {
  const recognitionRef = useRef<unknown | null>(null);
  const targetPhrase = phrase;
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);

  // Feature-detect on mount (client-only) so consumers can label/disable the
  // toggle and we can show a "listening" indicator only when it's real.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(detectSupport());
  }, []);

  useEffect(() => {
    // When disabled we simply don't start a session; the previous run's cleanup
    // (which sets listening=false) already handled the enabled→disabled flip, so
    // no synchronous setState is needed here.
    if (!enabled) return;
    if (typeof window === "undefined") return;

    type WindowWithSR = Window & {
      SpeechRecognition?: new () => unknown;
      webkitSpeechRecognition?: new () => unknown;
    };
    const w = window as WindowWithSR;
    const SpeechRecognitionCtor =
      w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      // Browser doesn't support SpeechRecognition (Firefox doesn't ship it)
      return;
    }

    type RecognitionInstance = {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      onresult:
        | ((event: {
            results: ArrayLike<ArrayLike<{ transcript: string }>>;
          }) => void)
        | null;
      onstart: (() => void) | null;
      onerror: ((event: unknown) => void) | null;
      onend: (() => void) | null;
      start: () => void;
      stop: () => void;
    };

    const rec = new SpeechRecognitionCtor() as RecognitionInstance;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onstart = () => setListening(true);

    rec.onresult = (event) => {
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (matchesWakePhrase(transcript, targetPhrase)) {
          onWake();
        }
      }
    };

    let stoppedByUser = false;
    rec.onend = () => {
      // SpeechRecognition auto-stops periodically — restart unless we explicitly stopped
      if (!stoppedByUser) {
        try {
          rec.start();
        } catch {
          /* already started */
        }
      } else {
        setListening(false);
      }
    };

    rec.onerror = () => {
      // Most common: "no-speech" timeout or "aborted" on unmount — ignore.
      // A hard error (e.g. permission denied) means we're not actually live.
      setListening(false);
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch {
      /* permission denied or already started */
    }

    return () => {
      stoppedByUser = true;
      setListening(false);
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
      recognitionRef.current = null;
    };
  }, [enabled, targetPhrase, onWake]);

  return { supported, listening };
}
