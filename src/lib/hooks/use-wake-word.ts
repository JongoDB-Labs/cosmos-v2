"use client";
import { useEffect, useRef } from "react";

interface WakeWordOptions {
  phrase: string; // case-insensitive substring to listen for, e.g. "hey cosmos"
  enabled: boolean;
  onWake: () => void;
}

export function useWakeWord({ phrase, enabled, onWake }: WakeWordOptions) {
  const recognitionRef = useRef<unknown | null>(null);
  const targetPhrase = phrase.toLowerCase();

  useEffect(() => {
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
      onerror: ((event: unknown) => void) | null;
      onend: (() => void) | null;
      start: () => void;
      stop: () => void;
    };

    const rec = new SpeechRecognitionCtor() as RecognitionInstance;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

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
      }
    };

    rec.onerror = () => {
      // Most common: "no-speech" timeout or "aborted" on unmount — ignore
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch {
      /* permission denied or already started */
    }

    return () => {
      stoppedByUser = true;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
      recognitionRef.current = null;
    };
  }, [enabled, targetPhrase, onWake]);
}
