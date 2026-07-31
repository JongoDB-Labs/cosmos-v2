// @vitest-environment jsdom
/**
 * #52 — the "Delivery mapping" pickers must actually offer the org's work-item
 * types, so the setting the release is about can be reached.
 *
 * This exists because everything AROUND the setting was covered — the resolver
 * in `@/lib/okr/link-type-default`, and the two link pickers that consume it —
 * but nothing rendered the settings screen itself. A picker that never lists a
 * type would leave the feature shipped-but-unconfigurable, and no existing test
 * would have said so.
 *
 * A "one option only" reading was once seen on prod and taken for that very
 * regression. It wasn't: the page was being measured through tooling that
 * prevented it from hydrating. Verified afterwards on a normally-loaded page,
 * both pickers offer all 57 of the org's types and default to Feature. The
 * guard below is still worth having — it is the only coverage of this screen —
 * but it guards a gap, not a bug that ever reached a user.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectSettingsClient } from "./project-settings-client";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/settings",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

vi.mock("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));

vi.mock("@/components/providers/permissions-provider", () => ({
  usePermissions: () => ({ can: () => true }),
  Permission: new Proxy({}, { get: (_t, k) => String(k) }),
}));

const TYPES = [
  { id: "t-story", key: "software.story", name: "Story", sortOrder: 1 },
  { id: "t-epic", key: "software.epic", name: "Epic", sortOrder: 2 },
  { id: "t-feature", key: "feature", name: "Feature", sortOrder: 3 }, // bare custom key
];

let typesRequested = 0;

beforeEach(() => {
  typesRequested = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/work-item-types")) {
        typesRequested += 1;
        return new Response(JSON.stringify(TYPES), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSettings(over: Partial<Record<string, unknown>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProjectSettingsClient
        orgId="org-1"
        orgSlug="acme"
        projectId="p1"
        projectName="P"
        projectKey="FSC"
        projectDescription=""
        enabledFeatures={[]}
        disabledBoardTypes={[]}
        boards={[{ id: "b1", name: "Sprint Board", type: "SCRUM" }]}
        hiddenBoardIds={[]}
        teamScopedAccess={false}
        krLinkTypeId={null}
        objectiveLinkTypeId={null}
        {...over}
      />
    </QueryClientProvider>,
  );
}

describe("Delivery mapping pickers", () => {
  it("requests the org's work-item types", async () => {
    renderSettings();
    await waitFor(() => expect(typesRequested).toBeGreaterThan(0));
  });

  it("lists every type as an option, not just the default", async () => {
    // Dropping the `types.map(...)` in LinkTypeRow leaves exactly one option —
    // the resolved default — and the setting becomes unreachable. That is the
    // failure this asserts against.
    renderSettings();
    const kr = (await screen.findByLabelText("Key results deliver")) as HTMLSelectElement;
    await waitFor(() => expect(kr.options.length).toBeGreaterThan(1));
    const labels = [...kr.options].map((o) => o.textContent?.trim());
    expect(labels).toContain("Feature");
    expect(labels).toContain("Story");
    expect(labels).toContain("Epic");
  });

  it("names Feature as the resolved default when nothing is configured", async () => {
    renderSettings();
    const kr = (await screen.findByLabelText("Key results deliver")) as HTMLSelectElement;
    await waitFor(() =>
      expect(kr.options[0]?.textContent).toMatch(/Default \(Feature\)/),
    );
  });

  it("both pickers are independently populated", async () => {
    renderSettings({ objectiveLinkTypeId: "t-epic" });
    const obj = (await screen.findByLabelText("Objectives deliver")) as HTMLSelectElement;
    await waitFor(() => expect(obj.options.length).toBeGreaterThan(1));
    expect(obj.value).toBe("t-epic");
  });
});
