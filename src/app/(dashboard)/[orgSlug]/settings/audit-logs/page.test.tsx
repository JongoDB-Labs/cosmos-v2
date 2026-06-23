// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { OrgRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

afterEach(cleanup);

// ── Module mocks ──────────────────────────────────────────────────────────────

// next/navigation: prevent redirect() from throwing
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// next/cache: `cache()` is a pass-through in tests
vi.mock("next/cache", () => ({
  cache: (fn: unknown) => fn,
}));

// @/lib/auth/session: controlled getAuthContext
const mockGetAuthContext = vi.fn<() => Promise<AuthContext | null>>();
vi.mock("@/lib/auth/session", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAuthContext: (_orgSlug: string) => mockGetAuthContext(),
}));

// AuditLogViewer is a "use client" component — stub it so the page
// can render without the full client-side stack.
vi.mock("@/components/security/audit-log-viewer", () => ({
  AuditLogViewer: ({ orgId }: { orgId: string }) => (
    <div data-testid="audit-log-viewer" data-org-id={orgId}>
      Audit log viewer
    </div>
  ),
}));

// PageShell + EmptyState are real UI — stub them lightly so we don't need
// the full Radix/Tailwind tree in jsdom.
vi.mock("@/components/ui/page-shell", () => ({
  PageShell: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/empty-state", () => ({
  EmptyState: ({ title, description }: { title: string; description?: string }) => (
    <div>
      <p>{title}</p>
      {description && <p>{description}</p>}
    </div>
  ),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(permissions: bigint): AuthContext {
  return {
    userId: "u1",
    orgId: "org1",
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

async function renderPage() {
  // Import lazily so mocks are in place before the module loads
  const { default: AuditLogsPage } = await import("./page");
  const jsx = await AuditLogsPage({
    params: Promise.resolve({ orgSlug: "test-org" }),
  });
  render(jsx as React.ReactElement);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AuditLogsPage RBAC gate", () => {
  it("Test A: renders NoAccess when permissions = 0n", async () => {
    mockGetAuthContext.mockResolvedValue(makeCtx(0n));
    await renderPage();
    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.queryByTestId("audit-log-viewer")).not.toBeInTheDocument();
  });

  it("Test B: renders the viewer when permissions include AUDIT_LOG_READ", async () => {
    mockGetAuthContext.mockResolvedValue(makeCtx(Permission.AUDIT_LOG_READ));
    await renderPage();
    expect(screen.queryByText(/don't have access/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("audit-log-viewer")).toBeInTheDocument();
  });
});
