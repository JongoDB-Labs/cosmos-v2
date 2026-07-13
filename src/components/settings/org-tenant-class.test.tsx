// @vitest-environment jsdom
//
// The tenant-facing, TIGHTEN-ONLY tenant-class control. Proves the asymmetric UI:
//   - an OWNER can pick a MORE-protective class and apply it (PATCHes the tenant route);
//   - the LESS-protective (loosen) option is DISABLED with a platform-admin-only note;
//   - a GOV org (already most protective) has nothing to tighten to — apply stays disabled;
//   - a non-owner sees the class read-only (no picker).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { OrgTenantClass } from "./org-tenant-class";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ORG_ID = "org-123";

function mockFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ orgId: ORG_ID, tenantClass: "GOV" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => vi.clearAllMocks());

describe("OrgTenantClass — OWNER of a COMMERCIAL org can TIGHTEN", () => {
  it("shows both classes; GOV (more protective) is selectable, and applying PATCHes to GOV", async () => {
    const fetchMock = mockFetchOk();
    render(<OrgTenantClass orgId={ORG_ID} current="COMMERCIAL" isOwner />);

    const gov = screen.getByRole("radio", { name: "GOV" });
    const commercial = screen.getByRole("radio", { name: "COMMERCIAL" });
    // GOV is a tighten from COMMERCIAL → enabled; COMMERCIAL is current → checked, enabled.
    expect(gov).not.toBeDisabled();
    expect(commercial).not.toBeDisabled();
    expect(commercial).toBeChecked();

    // No loosen option is present from COMMERCIAL, so no platform-admin-only note yet.
    expect(screen.queryByText(/platform administrator only/i)).not.toBeInTheDocument();

    // Apply is disabled until a real tighten is staged.
    expect(screen.getByRole("button", { name: /increase protection/i })).toBeDisabled();

    // Pick GOV → the irreversibility warning appears and Apply enables.
    fireEvent.click(gov);
    expect(screen.getByText(/cannot be undone by you/i)).toBeInTheDocument();
    const apply = screen.getByRole("button", { name: /increase protection/i });
    expect(apply).not.toBeDisabled();

    // ConfirmButton is two-step: first click arms, second confirms.
    fireEvent.click(apply);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, increase protection to GOV/i }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/v1/orgs/${ORG_ID}/tenant-class`);
    expect((opts as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ tenantClass: "GOV" });
    expect(refresh).toHaveBeenCalled();
  });
});

describe("OrgTenantClass — OWNER of a GOV org cannot loosen self-service", () => {
  it("disables the less-protective COMMERCIAL option with a platform-admin-only note, and nothing to apply", () => {
    render(<OrgTenantClass orgId={ORG_ID} current="GOV" isOwner />);

    const gov = screen.getByRole("radio", { name: "GOV" });
    const commercial = screen.getByRole("radio", { name: "COMMERCIAL" });
    expect(gov).toBeChecked();
    // COMMERCIAL is a LOOSEN from GOV → disabled + platform-admin-only note shown.
    expect(commercial).toBeDisabled();
    expect(screen.getByText(/platform administrator only/i)).toBeInTheDocument();

    // Already most protective — nothing to tighten to, Apply stays disabled.
    expect(screen.getByRole("button", { name: /increase protection/i })).toBeDisabled();
  });
});

describe("OrgTenantClass — non-owner", () => {
  it("renders the class read-only with no picker", () => {
    render(<OrgTenantClass orgId={ORG_ID} current="GOV" isOwner={false} />);

    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(
      screen.getByText(/only the organization owner can change the tenant class/i),
    ).toBeInTheDocument();
    // The current class is still shown (a tenant admin can READ tenantClass).
    expect(screen.getByText("GOV")).toBeInTheDocument();
  });
});
