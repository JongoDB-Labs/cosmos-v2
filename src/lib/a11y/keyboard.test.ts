import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { activateOnKey } from "./keyboard";

function ev(key: string) {
  return { key, preventDefault: vi.fn() } as unknown as KeyboardEvent;
}

describe("activateOnKey", () => {
  it("fires the handler on Enter and prevents default", () => {
    const fn = vi.fn();
    const e = ev("Enter");
    activateOnKey(fn)(e);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("fires the handler on Space and prevents default (no page scroll)", () => {
    const fn = vi.fn();
    const e = ev(" ");
    activateOnKey(fn)(e);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys (no handler call, no preventDefault)", () => {
    const fn = vi.fn();
    for (const key of ["a", "Tab", "Escape", "ArrowDown"]) {
      const e = ev(key);
      activateOnKey(fn)(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(fn).not.toHaveBeenCalled();
  });
});
