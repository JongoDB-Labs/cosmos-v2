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

// next/cache: cache() is a pass-through in tests
vi.mock("next/cache", () => ({
  cache: (fn: unknown) => fn,
}));

// @/lib/auth/session: controlled getAuthContext
const mockGetAuthContext = vi.fn<() => Promise<AuthContext | null>>();
vi.mock("@/lib/auth/session", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAuthContext: (_orgSlug: string) => mockGetAuthContext(),
}));

// @/lib/db/client: stub prisma.organization.findUnique
const mockFindUnique = vi.fn();
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
  },
}));

// Stub child client components so the async server component renders
// without needing the full client-side stack (React Query, Radix, etc.).
vi.mock("@/components/settings/org-general-settings", () => ({
  OrgGeneralSettings: ({ orgId, canUpdate }: { orgId: string; canUpdate: boolean }) => (
    <div data-testid="org-general-settings" data-org-id={orgId} data-can-update={String(canUpdate)}>
      Identity section
    </div>
  ),
}));

vi.mock("@/components/settings/org-branding-section", () => ({
  OrgBrandingSection: ({ orgId }: { orgId: string }) => (
    <div data-testid="org-branding-section" data-org-id={orgId}>
      Branding section
    </div>
  ),
}));

vi.mock("@/components/settings/org-danger-zone", () => ({
  OrgDangerZone: ({ orgId, orgName }: { orgId: string; orgName: string }) => (
    <div data-testid="org-danger-zone" data-org-id={orgId} data-org-name={orgName}>
      Danger zone
    </div>
  ),
}));

vi.mock("@/components/settings/org-tenant-class", () => ({
  OrgTenantClass: ({
    orgId,
    current,
    isOwner,
  }: {
    orgId: string;
    current: string;
    isOwner: boolean;
  }) => (
    <div
      data-testid="org-tenant-class"
      data-org-id={orgId}
      data-current={current}
      data-is-owner={String(isOwner)}
    >
      Tenant class section
    </div>
  ),
}));

// Light stubs for layout primitives — keeps the test focused on RBAC logic.
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

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(permissions: bigint, orgRole: OrgRole = OrgRole.MEMBER): AuthContext {
  return {
    userId: "u1",
    orgId: "org-abc",
    orgRole,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

const FAKE_ORG = {
  name: "Acme Inc",
  slug: "acme",
  logoUrl: null,
  plan: "ENTERPRISE",
  tenantClass: "GOV",
  themePrimary: null,
  themeMode: null,
  defaultSkinId: null,
  brandName: null,
  agentName: null,
  tagline: null,
  wakeWord: null,
};

async function renderPage() {
  // Import lazily so mocks are in place before the module loads.
  const { default: OrganizationPage } = await import("./page");
  const jsx = await OrganizationPage({
    params: Promise.resolve({ orgSlug: "acme" }),
  });
  render(jsx as React.ReactElement);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OrganizationPage RBAC gate", () => {
  it("Test A: renders NoAccess when permissions = 0n (no ORG_UPDATE or THEME_MANAGE)", async () => {
    mockGetAuthContext.mockResolvedValue(makeCtx(0n));
    mockFindUnique.mockResolvedValue(FAKE_ORG);

    await renderPage();

    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.queryByTestId("org-general-settings")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-branding-section")).not.toBeInTheDocument();
  });

  it("Test B: renders Identity section but NOT Brand section with ORG_UPDATE only", async () => {
    mockGetAuthContext.mockResolvedValue(makeCtx(Permission.ORG_UPDATE));
    mockFindUnique.mockResolvedValue(FAKE_ORG);

    await renderPage();

    expect(screen.queryByText(/don't have access/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("org-general-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("org-branding-section")).not.toBeInTheDocument();
  });

  it("Test C: renders both Identity and Brand sections with THEME_MANAGE", async () => {
    mockGetAuthContext.mockResolvedValue(makeCtx(Permission.THEME_MANAGE));
    mockFindUnique.mockResolvedValue(FAKE_ORG);

    await renderPage();

    expect(screen.queryByText(/don't have access/i)).not.toBeInTheDocument();
    // canViewSettings allows THEME_MANAGE → Identity section renders
    expect(screen.getByTestId("org-general-settings")).toBeInTheDocument();
    // canBrand = true → Brand section renders
    expect(screen.getByTestId("org-branding-section")).toBeInTheDocument();
  });

  it("Test C (variant): both sections present with ORG_UPDATE | THEME_MANAGE", async () => {
    mockGetAuthContext.mockResolvedValue(
      makeCtx(Permission.ORG_UPDATE | Permission.THEME_MANAGE),
    );
    mockFindUnique.mockResolvedValue(FAKE_ORG);

    await renderPage();

    expect(screen.getByTestId("org-general-settings")).toBeInTheDocument();
    expect(screen.getByTestId("org-branding-section")).toBeInTheDocument();
  });

  it("Test D: danger zone NOT rendered without ORG_DELETE", async () => {
    mockGetAuthContext.mockResolvedValue(makeCtx(Permission.ORG_UPDATE));
    mockFindUnique.mockResolvedValue(FAKE_ORG);

    await renderPage();

    expect(screen.queryByTestId("org-danger-zone")).not.toBeInTheDocument();
  });

  it("Test E: danger zone IS rendered with ORG_DELETE", async () => {
    mockGetAuthContext.mockResolvedValue(
      makeCtx(Permission.ORG_UPDATE | Permission.ORG_DELETE),
    );
    mockFindUnique.mockResolvedValue(FAKE_ORG);

    await renderPage();

    expect(screen.getByTestId("org-danger-zone")).toBeInTheDocument();
    expect(screen.getByTestId("org-danger-zone")).toHaveAttribute("data-org-name", "Acme Inc");
  });

  it("Test F: ORG_DELETE-only holder can view the page, sees danger zone and read-only Identity, but no Brand section", async () => {
    mockGetAuthContext.mockResolvedValue(makeCtx(Permission.ORG_DELETE));
    mockFindUnique.mockResolvedValue(FAKE_ORG);

    await renderPage();

    // Page is accessible — no NoAccess rendered
    expect(screen.queryByText(/don't have access/i)).not.toBeInTheDocument();

    // Identity section IS present but read-only (canUpdate=false)
    const identitySection = screen.getByTestId("org-general-settings");
    expect(identitySection).toBeInTheDocument();
    expect(identitySection).toHaveAttribute("data-can-update", "false");

    // Brand section is ABSENT — no THEME_MANAGE
    expect(screen.queryByTestId("org-branding-section")).not.toBeInTheDocument();

    // Danger zone IS present
    expect(screen.getByTestId("org-danger-zone")).toBeInTheDocument();
  });
});

describe("OrganizationPage — tenant-class control wiring", () => {
  it("renders the tenant-class control for any page viewer, read-only for a non-owner", async () => {
    // A THEME_MANAGE-only admin can view the page but is NOT the owner.
    mockGetAuthContext.mockResolvedValue(makeCtx(Permission.THEME_MANAGE, OrgRole.ADMIN));
    mockFindUnique.mockResolvedValue(FAKE_ORG);

    await renderPage();

    const section = screen.getByTestId("org-tenant-class");
    expect(section).toBeInTheDocument();
    expect(section).toHaveAttribute("data-current", "GOV");
    expect(section).toHaveAttribute("data-is-owner", "false");
  });

  it("passes isOwner=true only when the caller's org role is OWNER", async () => {
    mockGetAuthContext.mockResolvedValue(makeCtx(Permission.ORG_UPDATE, OrgRole.OWNER));
    mockFindUnique.mockResolvedValue(FAKE_ORG);

    await renderPage();

    expect(screen.getByTestId("org-tenant-class")).toHaveAttribute("data-is-owner", "true");
  });
});
