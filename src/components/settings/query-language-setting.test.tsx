// @vitest-environment jsdom
// The query language beta switch: only for people who manage org settings,
// and flipping it PUTs the new value.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/settings/organization", useParams: () => ({ orgSlug: "alpha" }) }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));

import { QueryLanguageOrgSwitch } from "./query-language-setting";
import { jsonFetch } from "@/lib/query/json-fetcher";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("QueryLanguageOrgSwitch", () => {
  it("is hidden from people who can't manage org settings", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ enabled: true, canManage: false } as never);
    wrap(<QueryLanguageOrgSwitch orgId="o1" />);
    await waitFor(() => expect(jsonFetch).toHaveBeenCalled());
    expect(screen.queryByRole("switch", { name: "Query language (beta)" })).toBeNull();
  });

  it("turns the beta on", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ enabled: false, canManage: true } as never);
    wrap(<QueryLanguageOrgSwitch orgId="o1" />);
    const sw = await screen.findByRole("switch", { name: "Query language (beta)" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/query-language", { method: "PUT", body: JSON.stringify({ enabled: true }) }),
    );
  });

  it("titles in filter emails: shown only with the beta on, and PUTs just that setting", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ enabled: true, emailTitles: false, canManage: true } as never);
    wrap(<QueryLanguageOrgSwitch orgId="o1" />);
    const sw = await screen.findByRole("switch", { name: "Include titles in filter emails" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/query-language", { method: "PUT", body: JSON.stringify({ emailTitles: true }) }),
    );
  });

  it("no titles toggle while the beta is off", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ enabled: false, emailTitles: true, canManage: true } as never);
    wrap(<QueryLanguageOrgSwitch orgId="o1" />);
    await screen.findByRole("switch", { name: "Query language (beta)" });
    expect(screen.queryByRole("switch", { name: "Include titles in filter emails" })).toBeNull();
  });
});
