// @vitest-environment jsdom
//
// Feedback discussion, Phase 2: following a request, and staff merging one
// request into another (and undoing it).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: h.jsonFetch }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { FeedbackFollowButton } from "./feedback-follow-button";
import { MergeControls, MergedNotice } from "./feedback-merge-controls";
import type { FeedbackItem } from "./feedback-types";

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
  );
const fi = (over: Partial<FeedbackItem>): FeedbackItem =>
  ({
    id: "f1",
    type: "FEATURE",
    title: "Dark mode",
    description: "",
    status: "OPEN",
    voteCount: 0,
    hasVoted: false,
    isMine: false,
    createdAt: "2026-10-23T00:00:00.000Z",
    ...over,
  }) as FeedbackItem;
const calls = (method: string) => h.jsonFetch.mock.calls.filter(([, init]) => init?.method === method);

beforeEach(() => {
  h.jsonFetch.mockReset();
});
afterEach(cleanup);

describe("FeedbackFollowButton", () => {
  it("shows whether you follow, and toggles it", async () => {
    h.jsonFetch.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "PUT" ? JSON.parse(String(init.body)) : { following: false },
    );
    wrap(<FeedbackFollowButton orgId="o1" itemId="f1" />);
    const btn = await screen.findByRole("button", { name: /^Follow$/ });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(btn).toBeEnabled()); // disabled until we know
    fireEvent.click(btn);
    expect(await screen.findByRole("button", { name: /Following/ })).toHaveAttribute("aria-pressed", "true");
    expect(calls("PUT")[0][0]).toBe("/api/v1/orgs/o1/feedback/f1/subscription");
    expect(JSON.parse(String(calls("PUT")[0][1].body))).toEqual({ following: true });
  });
});

describe("MergeControls", () => {
  const candidates = [
    fi({ id: "f1", title: "Dark mode" }),
    fi({ id: "f2", title: "Night theme", voteCount: 4 }),
    fi({ id: "f3", title: "Offline mode" }),
    fi({ id: "f4", title: "Night colours", status: "MERGED" }),
  ];

  it("merges into a request picked from the board, never itself or a merged one", async () => {
    h.jsonFetch.mockResolvedValue({ merged: true });
    const onChanged = vi.fn();
    wrap(<MergeControls orgId="o1" item={candidates[0]} candidates={candidates} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: /Merge into/ }));
    fireEvent.change(await screen.findByLabelText("Search requests"), { target: { value: "night" } });
    expect(screen.queryByRole("button", { name: /Night colours/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Dark mode/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Offline mode/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Night theme/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls("POST")[0][0]).toBe("/api/v1/orgs/o1/feedback/f1/merge");
    expect(JSON.parse(String(calls("POST")[0][1].body))).toEqual({ survivorId: "f2" });
  });

  it("offers an undo on a merged request", async () => {
    h.jsonFetch.mockResolvedValue({ merged: false });
    const onChanged = vi.fn();
    wrap(<MergeControls orgId="o1" item={fi({ status: "MERGED" })} candidates={[]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo merge" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls("DELETE")[0][0]).toBe("/api/v1/orgs/o1/feedback/f1/merge");
  });
});

describe("MergedNotice", () => {
  it("names the request it was merged into and opens it", async () => {
    h.jsonFetch.mockResolvedValue(fi({ id: "f2", title: "Night theme" }));
    const onOpenItem = vi.fn();
    wrap(<MergedNotice orgId="o1" item={fi({ status: "MERGED", mergedIntoId: "f2" })} onOpenItem={onOpenItem} />);
    fireEvent.click(await screen.findByRole("button", { name: "Night theme" }));
    expect(onOpenItem).toHaveBeenCalledWith("f2");
    expect(h.jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/feedback/f2");
  });

  it("says so when the request it was merged into is gone, and shows nothing when not merged", () => {
    const { container } = wrap(<MergedNotice orgId="o1" item={fi({ status: "OPEN" })} onOpenItem={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    wrap(<MergedNotice orgId="o1" item={fi({ status: "MERGED", mergedIntoId: null })} onOpenItem={vi.fn()} />);
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
    expect(h.jsonFetch).not.toHaveBeenCalled();
  });
});
