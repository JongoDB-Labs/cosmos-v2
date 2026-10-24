import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { FetchError } from "@/lib/query/json-fetcher";
import type { TransitionErrorBody } from "@/lib/workflow/contract";
import { sendItemChange, TransitionBackedOut, useTransitionPrompt } from "./use-transition-prompt";
import type { TransitionInput } from "./transition-dialog";

const NEEDS_RESOLUTION: TransitionErrorBody = {
  error: "Resolve needs Resolution.",
  code: "transition_input_required",
  transition: { id: "resolve", name: "Resolve", to: "done" },
  fields: [{ field: { system: "resolution" }, required: true, options: [{ value: "Fixed", label: "Fixed" }] }],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const sentBodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

describe("sendItemChange", () => {
  it("returns the item when the change goes through", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: "a", columnKey: "done" }));
    expect(await sendItemChange("/x", { columnKey: "done" }, vi.fn())).toEqual({ id: "a", columnKey: "done" });
  });

  it("asks for what the transition needs and sends the same change again with it", async () => {
    fetchMock.mockResolvedValueOnce(json(422, NEEDS_RESOLUTION)).mockResolvedValueOnce(json(200, { id: "a" }));
    const ask = vi.fn(async () => ({ "system:resolution": "Fixed" }));
    await sendItemChange("/x", { columnKey: "done", boardId: "b" }, ask);
    expect(ask).toHaveBeenCalledWith(NEEDS_RESOLUTION);
    expect(sentBodies()).toEqual([
      { columnKey: "done", boardId: "b" },
      { columnKey: "done", boardId: "b", transition: { id: "resolve", input: { "system:resolution": "Fixed" } } },
    ]);
  });

  it("sends nothing more when the person backs out", async () => {
    fetchMock.mockResolvedValueOnce(json(422, NEEDS_RESOLUTION));
    await expect(sendItemChange("/x", { columnKey: "done" }, async () => null)).rejects.toBeInstanceOf(TransitionBackedOut);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws any other refusal with the server's own words, without asking", async () => {
    fetchMock.mockResolvedValueOnce(json(422, { error: "Finish its sub-items first: Child.", code: "transition_invalid" }));
    const ask = vi.fn();
    const err = (await sendItemChange("/x", { columnKey: "done" }, ask).catch((e: unknown) => e)) as FetchError;
    expect(err).toBeInstanceOf(FetchError);
    expect(err.message).toBe("Finish its sub-items first: Child.");
    expect(ask).not.toHaveBeenCalled();
  });
});

function Harness({ onAsk }: { onAsk: (ask: (r: TransitionErrorBody) => Promise<TransitionInput | null>) => void }) {
  const { ask, dialog } = useTransitionPrompt();
  useEffect(() => onAsk(ask), [ask, onAsk]);
  return dialog;
}

describe("useTransitionPrompt", () => {
  it("opens the dialog with the transition's fields and resolves with what was entered", async () => {
    let ask!: (r: TransitionErrorBody) => Promise<TransitionInput | null>;
    render(<Harness onAsk={(a) => (ask = a)} />);
    let answer!: Promise<TransitionInput | null>;
    act(() => {
      answer = ask(NEEDS_RESOLUTION);
    });
    const dlg = await screen.findByRole("dialog", { name: "Resolve" });
    const submit = within(dlg).getByRole("button", { name: "Resolve" });
    // Required and empty: nothing to send yet.
    expect(submit).toBeDisabled();
    fireEvent.click(within(dlg).getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Fixed" }));
    fireEvent.click(submit);
    expect(await answer).toEqual({ "system:resolution": "Fixed" });
  });

  it("resolves with null when the dialog is closed", async () => {
    let ask!: (r: TransitionErrorBody) => Promise<TransitionInput | null>;
    render(<Harness onAsk={(a) => (ask = a)} />);
    let answer!: Promise<TransitionInput | null>;
    act(() => {
      answer = ask(NEEDS_RESOLUTION);
    });
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(await answer).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
