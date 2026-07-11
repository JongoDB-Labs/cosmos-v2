// Functional test of the wake path with a mocked Web Speech API: proves the
// phrase-matching → onWake wiring works end-to-end (the only part a headless
// test can't cover is the browser's actual audio recognition).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWakeWord } from "./use-wake-word";

type ResultHandler = ((e: unknown) => void) | null;

class MockRecognition {
  static instances: MockRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ResultHandler = null;
  onend: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onstart: (() => void) | null = null;
  started = 0;
  stopped = 0;
  constructor() {
    MockRecognition.instances.push(this);
  }
  start() {
    this.started++;
    this.onstart?.();
  }
  stop() {
    this.stopped++;
    this.onend?.();
  }
  abort() {
    this.stopped++;
  }
}

function speech(transcript: string) {
  // Shape of a SpeechRecognitionEvent's results list, minimally.
  return { results: [[{ transcript }]], resultIndex: 0 };
}

beforeEach(() => {
  MockRecognition.instances = [];
  (window as unknown as Record<string, unknown>).SpeechRecognition = MockRecognition;
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  vi.restoreAllMocks();
});

describe("useWakeWord", () => {
  it("wakes on an utterance containing the phrase (case-insensitive)", () => {
    const onWake = vi.fn();
    renderHook(() => useWakeWord({ phrase: "hey cosmo", enabled: true, onWake }));
    const rec = MockRecognition.instances.at(-1)!;
    expect(rec.started).toBe(1);
    act(() => rec.onresult?.(speech("okay so Hey Cosmo open my tasks")));
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("legacy 'hey cosmos' utterances still wake it (substring compatibility)", () => {
    const onWake = vi.fn();
    renderHook(() => useWakeWord({ phrase: "hey cosmo", enabled: true, onWake }));
    const rec = MockRecognition.instances.at(-1)!;
    act(() => rec.onresult?.(speech("hey cosmos what's on my plate")));
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("does not wake on unrelated speech", () => {
    const onWake = vi.fn();
    renderHook(() => useWakeWord({ phrase: "hey cosmo", enabled: true, onWake }));
    const rec = MockRecognition.instances.at(-1)!;
    act(() => rec.onresult?.(speech("hey cosplay convention is saturday")));
    expect(onWake).not.toHaveBeenCalled();
  });

  it("does nothing while disabled and reports supported=true with the API present", () => {
    const onWake = vi.fn();
    const { result } = renderHook(() => useWakeWord({ phrase: "hey cosmo", enabled: false, onWake }));
    expect(MockRecognition.instances.length).toBe(0);
    expect(result.current.supported).toBe(true);
    expect(result.current.listening).toBe(false);
  });

  it("degrades gracefully when the browser lacks the API (Firefox)", () => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    const onWake = vi.fn();
    const { result } = renderHook(() => useWakeWord({ phrase: "hey cosmo", enabled: true, onWake }));
    expect(result.current.supported).toBe(false);
    expect(result.current.listening).toBe(false);
  });
});
