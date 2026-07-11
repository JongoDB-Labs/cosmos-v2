// Proves WakeWordProvider broadcasts the ACTUAL live-mic state on
// `cosmos:wake-word:listening`, so out-of-tree controls (the sidebar toggle)
// can render the filled/active state and the live-mic warning truthfully —
// only while the mic is really capturing, and cleared the instant it stops.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { WakeWordProvider } from "./wake-word-provider";

class MockRecognition {
  static instances: MockRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((e: unknown) => void) | null = null;
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

let events: boolean[] = [];
function onListening(e: Event) {
  events.push(Boolean((e as CustomEvent).detail));
}

beforeEach(() => {
  MockRecognition.instances = [];
  events = [];
  (window as unknown as Record<string, unknown>).SpeechRecognition =
    MockRecognition;
  window.localStorage.setItem("cosmos:wake-word-enabled", "true");
  window.addEventListener("cosmos:wake-word:listening", onListening);
});
afterEach(() => {
  window.removeEventListener("cosmos:wake-word:listening", onListening);
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  window.localStorage.clear();
  cleanup();
  vi.restoreAllMocks();
});

describe("WakeWordProvider live-mic broadcast", () => {
  it("emits listening=true once the recognition session starts", () => {
    act(() => {
      render(<WakeWordProvider />);
    });
    expect(MockRecognition.instances.length).toBe(1);
    expect(events.at(-1)).toBe(true);
  });

  it("emits listening=false immediately when the toggle is switched off", () => {
    act(() => {
      render(<WakeWordProvider />);
    });
    expect(events.at(-1)).toBe(true);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("cosmos:wake-word:toggle", { detail: false }),
      );
    });
    expect(events.at(-1)).toBe(false);
  });
});
