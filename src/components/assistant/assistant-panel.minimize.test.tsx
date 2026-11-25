// @vitest-environment jsdom
//
// A minimized assistant stays mounted (so the conversation survives), but a
// hidden panel must not keep the microphone open: minimizing stops dictation.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

let minimized = false;
vi.mock("@/components/drawers/drawer-provider", () => ({
  useDrawers: () => ({ seed: null, minimized }),
}));
const stop = vi.fn();
vi.mock("@/lib/hooks/use-dictation", () => ({
  useDictation: () => ({ supported: true, listening: true, start: vi.fn(), stop }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/acme" }));
vi.mock("@/lib/hooks/use-media-query", () => ({ useMediaQuery: () => true }));

import { AssistantPanel } from "./assistant-panel";

beforeEach(() => {
  minimized = false;
  stop.mockReset();
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AssistantPanel — minimized", () => {
  it("stops a listening dictation when minimized, not before", () => {
    const { rerender } = render(<AssistantPanel orgId="o1" />);
    expect(stop).not.toHaveBeenCalled();
    minimized = true;
    rerender(<AssistantPanel orgId="o1" />);
    expect(stop).toHaveBeenCalled();
  });
});
