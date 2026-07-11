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

export function useWakeWord({
  phrase,
  enabled,
  onWake,
}: WakeWordOptions): WakeWordStatus {
  const recognitionRef = useRef<unknown | null>(null);
  const targetPhrase = phrase.toLowerCase();
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
        const transcript = result[0]?.transcript?.toLowerCase() ?? "";
        if (transcript.includes(targetPhrase)) {
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
