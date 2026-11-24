// Test helper (not a test file): the shared cases every React Query board view
// runs for "a failed background refresh keeps the loaded board". Each view's
// `*.refresh-error.test.tsx` mocks what that view needs and calls
// describeRefreshError. See board-load-state.ts for the rule under test.
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { REFRESH_FAILED_MESSAGE } from "./use-refresh-failed-notice";

export interface RefreshErrorCase {
  name: string;
  /** The view, rendered with fixed props. */
  view: () => ReactElement;
  /** Text that is on screen when the view has loaded. */
  content: string;
  /** The view's critical reads, by name, and how to recognise each request. */
  reads: Record<string, (url: string) => boolean>;
  /** The body (unwrapped) the server answers for a URL. */
  respond: (url: string) => unknown;
  /** The `sonner` toast mock's methods. */
  toasts: { warning: Mock; dismiss: Mock };
}

const ok = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200 });
const fail = (status: number) => new Response(JSON.stringify({ error: `HTTP ${status}` }), { status });

export function describeRefreshError(c: RefreshErrorCase) {
  describe(`${c.name}: a failed background refresh keeps the loaded board`, () => {
    const failing: Record<string, number> = {};

    beforeEach(() => {
      for (const k of Object.keys(failing)) delete failing[k];
      c.toasts.warning.mockClear();
      c.toasts.dismiss.mockClear();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : input);
          const method = init?.method ?? "GET";
          if (method === "GET") {
            for (const [read, match] of Object.entries(c.reads)) {
              if (failing[read] && match(url)) return fail(failing[read]);
            }
          }
          return ok(c.respond(url));
        }),
      );
    });
    afterEach(() => {
      cleanup();
      vi.unstubAllGlobals();
    });

    function renderView() {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(<QueryClientProvider client={qc}>{c.view()}</QueryClientProvider>);
      return qc;
    }
    const tryAgain = () => screen.queryByRole("button", { name: "Try again" });

    for (const read of Object.keys(c.reads)) {
      it(`keeps the board when the ${read} refresh fails, then clears the notice`, async () => {
        const qc = renderView();
        await screen.findAllByText(c.content, {}, { timeout: 5000 });

        failing[read] = 500;
        await act(() => qc.invalidateQueries());
        await vi.waitFor(() =>
          expect(c.toasts.warning).toHaveBeenCalledWith(REFRESH_FAILED_MESSAGE, expect.anything()),
        );
        expect(screen.getAllByText(c.content).length).toBeGreaterThan(0);
        expect(tryAgain()).toBeNull();

        delete failing[read];
        await act(() => qc.invalidateQueries());
        await vi.waitFor(() => expect(c.toasts.dismiss).toHaveBeenCalled());
        expect(screen.getAllByText(c.content).length).toBeGreaterThan(0);
        expect(c.toasts.warning).toHaveBeenCalledTimes(1);
      });

      it(`a 403 on the ${read} refresh replaces the board with a LoadError`, async () => {
        const qc = renderView();
        await screen.findAllByText(c.content, {}, { timeout: 5000 });

        failing[read] = 403;
        await act(() => qc.invalidateQueries());
        await vi.waitFor(() => expect(tryAgain()).not.toBeNull());
        expect(screen.queryAllByText(c.content)).toHaveLength(0);
      });

      it(`a cold ${read} load failure is a LoadError, and Try again recovers`, async () => {
        failing[read] = 500;
        renderView();
        await vi.waitFor(() => expect(tryAgain()).not.toBeNull(), { timeout: 5000 });

        delete failing[read];
        fireEvent.click(tryAgain()!);
        await screen.findAllByText(c.content, {}, { timeout: 5000 });
        expect(tryAgain()).toBeNull();
      });
    }
  });
}
