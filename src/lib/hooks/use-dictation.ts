"use client";
// Voice dictation for the assistant input — the okr-dashboard ChatPanel's
// toggleVoice mechanics as a hook: a recognition session live-previews the
// transcript into the input, accumulates finalized segments across the
// engine's auto-restarts, and when the utterance ends with the user's CLOSE
// WORD ("send it" by default, customizable in Preferences → Voice) the phrase
// is stripped and the message sent. Stops after a send (wake again or click
// the mic for the next message), on error, or on explicit stop.
import { useCallback, useEffect, useRef, useState } from "react";
import { buildCloseWordRegex, matchCloseWord } from "@/lib/voice/close-word";

interface DictationOptions {
  /** Live transcript preview → the input box. */
  onTranscript: (text: string) => void;
  /** Close word detected: `text` is the message with the phrase stripped. */
  onSend: (text: string) => void;
  /** The user's close phrase (null/blank → "send it"). */
  closeWord?: string | null;
}

export interface DictationControls {
  supported: boolean;
  listening: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
}

type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SREvent = { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> };

function ctor(): (new () => SR) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as Window & { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function useDictation({ onTranscript, onSend, closeWord }: DictationOptions): DictationControls {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<SR | null>(null);
  // Refs so a live session always sees the CURRENT handlers/phrase without
  // being torn down mid-utterance by a re-render.
  const onTranscriptRef = useRef(onTranscript);
  const onSendRef = useRef(onSend);
  const closeRef = useRef(buildCloseWordRegex(closeWord));
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onSendRef.current = onSend;
    closeRef.current = buildCloseWordRegex(closeWord);
  }); // every commit — a live session always sees current handlers/phrase

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(Boolean(ctor()));
  }, []);

  const stop = useCallback(() => {
    const s = sessionRef.current;
    sessionRef.current = null; // signal onend: do not restart
    try {
      s?.stop();
    } catch {
      /* already stopped */
    }
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = ctor();
    if (!Ctor) {
      setError("Speech recognition isn't supported in this browser.");
      return;
    }
    if (sessionRef.current) return; // already dictating
    setError(null);
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-US";
    let sent = false;
    let accumulated = ""; // finalized text across the engine's auto-restarts

    rec.onstart = () => setListening(true);
    rec.onresult = (event) => {
      if (sent) return;
      const result = event.results[0];
      const transcript = result?.[0]?.transcript ?? "";
      const full = accumulated ? `${accumulated} ${transcript}` : transcript;
      if ((result as { isFinal?: boolean }).isFinal) accumulated = full;
      const message = matchCloseWord(full, closeRef.current);
      if (message !== null) {
        sent = true;
        sessionRef.current = null;
        try {
          rec.stop();
        } catch {
          /* stopping a stopped session */
        }
        onTranscriptRef.current("");
        if (message) onSendRef.current(message);
        setListening(false);
        return;
      }
      onTranscriptRef.current(full);
    };
    rec.onerror = (e) => {
      if (e.error !== "aborted") setError(`Voice error: ${e.error ?? "unknown"}`);
      sessionRef.current = null;
      setListening(false);
    };
    rec.onend = () => {
      // The engine ends sessions on silence — restart to keep the dictation
      // going, unless we sent/stopped (sessionRef cleared).
      if (!sent && sessionRef.current === rec) {
        try {
          rec.start();
        } catch {
          setListening(false);
        }
      } else {
        setListening(false);
      }
    };
    sessionRef.current = rec;
    rec.start();
  }, []);

  // Never leave the mic running after unmount (drawer closed).
  useEffect(() => stop, [stop]);

  return { supported, listening, error, start, stop };
}
