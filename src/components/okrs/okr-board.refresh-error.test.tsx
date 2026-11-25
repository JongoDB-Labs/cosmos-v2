// @vitest-environment jsdom
import { vi } from "vitest";
import { describeRefreshError } from "@/components/boards/shared/refresh-error-kit";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock("@/components/providers/permissions-provider", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  usePermissions: () => ({ orgId: "o1", orgSlug: "acme", role: "ADMIN", permissions: 0n, can: () => true }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/P1/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ orgSlug: "acme" }),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/hooks/use-work-item-realtime", () => ({ useWorkItemRealtime: () => {} }));
const toasts = vi.hoisted(() => ({ warning: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", async (orig) => {
  const real = (await orig()) as { toast: (...a: unknown[]) => unknown };
  return { ...(real as object), toast: Object.assign((...a: unknown[]) => real.toast(...a), real.toast, toasts) };
});

import { OkrBoard } from "./okr-board";

const OBJECTIVE = {
  id: "ob1", orgId: "o1", projectId: "p1", title: "Loaded objective", description: null,
  ownerId: null, period: null, status: "ACTIVE", progress: 40, targetDate: null, health: "no_date",
  overdue: false, dependsOn: [], sortOrder: 0, parentId: null, intervalId: null, committed: true,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", keyResults: [],
};

describeRefreshError({
  name: "OkrBoard",
  view: () => <OkrBoard orgId="o1" projectId="p1" />,
  content: "Loaded objective",
  reads: {
    objectives: (u) => u.endsWith("/objectives"),
  },
  respond: (u) => (u.endsWith("/objectives") ? [OBJECTIVE] : []),
  toasts,
});
