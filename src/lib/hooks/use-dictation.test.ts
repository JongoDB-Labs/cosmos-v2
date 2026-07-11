// Functional tests of the dictation loop with a mocked Web Speech API — the
// same harness pattern as use-wake-word.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDictation } from "./use-dictation";

class MockRecognition {
  static instances: MockRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
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
}

function speech(transcript: string, isFinal = false) {
  const seg = [{ transcript }] as Array<{ transcript: string }> & { isFinal?: boolean };
  seg.isFinal = isFinal;
  return { results: [seg], resultIndex: 0 };
}

beforeEach(() => {
  MockRecognition.instances = [];
  (window as unknown as Record<string, unknown>).SpeechRecognition = MockRecognition;
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  vi.restoreAllMocks();
});

describe("useDictation", () => {
  it("live-previews interim transcripts into the input", () => {
    const onTranscript = vi.fn();
    const onSend = vi.fn();
    const { result } = renderHook(() => useDictation({ onTranscript, onSend }));
    act(() => result.current.start());
    const rec = MockRecognition.instances.at(-1)!;
    expect(result.current.listening).toBe(true);
    act(() => rec.onresult?.(speech("create a ticket for")));
    expect(onTranscript).toHaveBeenLastCalledWith("create a ticket for");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("close word sends the stripped message, clears the input, and stops", () => {
    const onTranscript = vi.fn();
    const onSend = vi.fn();
    const { result } = renderHook(() => useDictation({ onTranscript, onSend }));
    act(() => result.current.start());
    const rec = MockRecognition.instances.at(-1)!;
    act(() => rec.onresult?.(speech("create a ticket for the login bug, send it.")));
    expect(onSend).toHaveBeenCalledWith("create a ticket for the login bug");
    expect(onTranscript).toHaveBeenLastCalledWith("");
    expect(result.current.listening).toBe(false);
    expect(rec.stopped).toBeGreaterThan(0);
  });

  it("honors a custom close word", () => {
    const onSend = vi.fn();
    const { result } = renderHook(() =>
      useDictation({ onTranscript: vi.fn(), onSend, closeWord: "over and out" }),
    );
    act(() => result.current.start());
    const rec = MockRecognition.instances.at(-1)!;
    act(() => rec.onresult?.(speech("ship the fix over and out")));
    expect(onSend).toHaveBeenCalledWith("ship the fix");
  });

  it("accumulates finalized segments across the engine's auto-restarts", () => {
    const onTranscript = vi.fn();
    const onSend = vi.fn();
    const { result } = renderHook(() => useDictation({ onTranscript, onSend }));
    act(() => result.current.start());
    const rec = MockRecognition.instances.at(-1)!;
    act(() => rec.onresult?.(speech("first half", true))); // finalized
    act(() => rec.onend?.()); // engine ends on silence → hook restarts SAME session
    act(() => rec.onresult?.(speech("second half send it")));
    expect(onSend).toHaveBeenCalledWith("first half second half");
  });

  it("a bare close word sends nothing but still stops cleanly", () => {
    const onSend = vi.fn();
    const { result } = renderHook(() => useDictation({ onTranscript: vi.fn(), onSend }));
    act(() => result.current.start());
    const rec = MockRecognition.instances.at(-1)!;
    act(() => rec.onresult?.(speech("send it")));
    expect(onSend).not.toHaveBeenCalled();
    expect(result.current.listening).toBe(false);
  });

  it("explicit stop() prevents the auto-restart", () => {
    const { result } = renderHook(() => useDictation({ onTranscript: vi.fn(), onSend: vi.fn() }));
    act(() => result.current.start());
    const rec = MockRecognition.instances.at(-1)!;
    act(() => result.current.stop());
    expect(result.current.listening).toBe(false);
    const started = rec.started;
    act(() => rec.onend?.());
    expect(rec.started).toBe(started); // no restart after explicit stop
  });

  it("degrades gracefully without the API", () => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    const { result } = renderHook(() => useDictation({ onTranscript: vi.fn(), onSend: vi.fn() }));
    expect(result.current.supported).toBe(false);
    act(() => result.current.start());
    expect(result.current.error).toMatch(/isn't supported/i);
  });
});
