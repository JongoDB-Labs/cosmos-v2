// @vitest-environment jsdom
//
// COSMOS-130 — subscribe side of the app-wide settings/membership live updates.
// The SettingsRealtime bridge is mounted once in the settings layout; when an
// org-scoped `settings.updated` / `member.updated` event arrives it must refresh
// the open settings views: invalidate the react-query-backed config/roles/member
// caches and `router.refresh()` the server-rendered pages.
//
// We stub the SSE hook (`useRealtimeEvents`) to capture the handler map the
// component registers, then invoke those handlers and assert the resulting
// cache invalidations + router refresh — the observable contract, without a
// real EventSource (which jsdom lacks).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Handlers = Record<string, (data: unknown) => void>;

const { refresh, captured } = vi.hoisted(() => ({
  refresh: vi.fn(),
  captured: { current: {} as Handlers },
}));

// The URL's first segment is the org slug (`useOrgSlug`), so query keys are
// prefixed ["org", "test-org", ...].
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => "/test-org/settings",
}));

vi.mock("@/hooks/use-realtime-events", () => ({
  useRealtimeEvents: (_orgId: string, handlers: Handlers) => {
    captured.current = handlers;
  },
}));

import { SettingsRealtime } from "./settings-realtime";

function renderBridge() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
  render(
    <QueryClientProvider client={qc}>
      <SettingsRealtime orgId="org-1" />
    </QueryClientProvider>,
  );
  return { invalidate };
}

describe("SettingsRealtime — subscribe side (COSMOS-130)", () => {
  beforeEach(() => {
    refresh.mockClear();
    captured.current = {};
  });
  afterEach(() => cleanup());

  it("registers handlers for the settings + membership events", () => {
    renderBridge();
    expect(Object.keys(captured.current).sort()).toEqual([
      "member.updated",
      "settings.updated",
    ]);
  });

  it("settings.updated → invalidates the config cache and refreshes the page", () => {
    const { invalidate } = renderBridge();
    captured.current["settings.updated"]({ orgId: "org-1", section: "automation" });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["org", "test-org", "feedback-remediation-config"],
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("member.updated → invalidates the roles + members caches and refreshes", () => {
    const { invalidate } = renderBridge();
    captured.current["member.updated"]({ orgId: "org-1", memberId: "m-1" });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["org", "test-org", "work-roles"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["org", "test-org", "members"],
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
