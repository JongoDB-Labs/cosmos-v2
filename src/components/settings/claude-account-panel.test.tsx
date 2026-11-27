// @vitest-environment jsdom
//
// The personal-Claude panel renders on /[orgSlug]/settings/profile but cached
// its status under a flat ["me", "claude-subscription"] key, so the cache entry
// was shared by every org the browser visited — the thing useOrgQueryKey exists
// to prevent (AGENTS.md, "Multi-tenant client cache").
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/settings/profile" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn(() => Promise.resolve({ connected: false })),
}));

import { ClaudeAccountPanel } from "./claude-account-panel";

afterEach(cleanup);

describe("ClaudeAccountPanel", () => {
  it("caches its status under the current org's namespace", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ClaudeAccountPanel />
      </QueryClientProvider>,
    );

    await screen.findByRole("button", { name: /Connect my Claude subscription/ });

    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([
      ["org", "acme", "me", "claude-subscription"],
    ]);
  });
});
