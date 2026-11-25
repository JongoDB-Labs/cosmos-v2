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

vi.mock("@/components/providers/permissions-provider", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  usePermissions: () => ({ orgId: "o1", orgSlug: "acme", role: "ADMIN", permissions: 0n, can: () => true }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/P1/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
const toasts = vi.hoisted(() => ({ warning: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", async (orig) => {
  const real = (await orig()) as { toast: (...a: unknown[]) => unknown };
  return { ...(real as object), toast: Object.assign((...a: unknown[]) => real.toast(...a), real.toast, toasts) };
});

import { TableView } from "./table-view";

const ITEM = {
  id: "i1", orgId: "o1", projectId: "p1", workItemTypeId: "t1", title: "Loaded row", description: "",
  columnKey: "todo", priority: "LOW", assigneeId: null, assignees: [], parentId: null, intervalId: null,
  ticketNumber: 1, tags: [], customFields: {}, archivedAt: null,
  startDate: null, dueDate: null, completedAt: null, storyPoints: null,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  workItemType: { id: "t1", key: "task", name: "Task", icon: null, color: null },
};

describeRefreshError({
  name: "Table",
  view: () => <TableView orgId="o1" projectId="p1" projectKey="P1" boardId="b1" />,
  content: "Loaded row",
  reads: {
    board: (u) => u.endsWith("/boards/b1"),
    items: (u) => u.endsWith("/work-items"),
  },
  respond: (u) => {
    if (u.endsWith("/boards/b1")) return { id: "b1", name: "Table", type: "TABLE", config: {}, columns: [] };
    if (u.endsWith("/work-items")) return [ITEM];
    if (u.endsWith("/query-language")) return { enabled: false, canManage: false };
    return [];
  },
  toasts,
});
