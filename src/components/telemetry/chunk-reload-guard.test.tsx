// @vitest-environment jsdom
//
// COSMOS-221: a post-deploy ChunkLoadError still recovers with one reload, but
// never while someone is mid-edit — that reload threw their input away.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

const toastMock = vi.fn();
vi.mock("sonner", () => ({ toast: (...args: unknown[]) => toastMock(...args) }));

import { ChunkReloadGuard } from "./chunk-reload-guard";

const reload = vi.fn();
const original = window.location;

beforeEach(() => {
  reload.mockReset();
  toastMock.mockReset();
  sessionStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...original, reload },
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  Object.defineProperty(window, "location", { configurable: true, value: original });
});

function chunkError(message = "ChunkLoadError: Loading chunk 812 failed.") {
  window.dispatchEvent(new ErrorEvent("error", { message }));
}

describe("ChunkReloadGuard", () => {
  it("reloads once on a chunk error when nothing is being edited", () => {
    render(<ChunkReloadGuard />);
    chunkError();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("offers the reload instead of forcing it while a text field has focus", () => {
    render(<ChunkReloadGuard />);
    const box = document.createElement("textarea");
    document.body.appendChild(box);
    box.focus();

    chunkError();

    expect(reload).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    const [, opts] = toastMock.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(opts.action.label).toBe("Reload");
    // The reload is still one click away, on the user's terms.
    opts.action.onClick();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload while a dialog is open, even with nothing focused", () => {
    render(<ChunkReloadGuard />);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);

    chunkError();

    expect(reload).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("treats a focused checkbox as nothing to lose", () => {
    render(<ChunkReloadGuard />);
    const cb = document.createElement("input");
    cb.type = "checkbox";
    document.body.appendChild(cb);
    cb.focus();

    chunkError();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("ignores errors that are not chunk-load failures", () => {
    render(<ChunkReloadGuard />);
    chunkError("TypeError: x is undefined");
    expect(reload).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });
});
