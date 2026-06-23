// @vitest-environment jsdom
// Migrated from src/components/ui/theme-picker.test.tsx (deleted in Task 5).
// Tests the extracted OrgBrandingSection component which holds the exact same
// org-branding UI + save logic that was previously inside ThemePicker.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { OrgBrandingSection } from "./org-branding-section";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/acme/settings/preferences",
}));

vi.mock("@/lib/theme/skins", () => ({
  SKIN_PRESETS: [
    {
      id: "universe",
      label: "Universe",
      description: "The classic",
      sectors: [],
      light: { "--bg": "#fff", "--surface": "#f0f0f0", "--primary": "#7C5CFF" },
      dark: { "--bg": "#0B0E1A", "--surface": "#1a2035", "--primary": "#7C5CFF" },
    },
    {
      id: "atelier",
      label: "Pontis",
      description: "Blueprint",
      sectors: ["aec"],
      light: { "--bg": "#f0f4f8", "--surface": "#e2e8f0", "--primary": "#0070f3" },
      dark: { "--bg": "#0a0f1a", "--surface": "#111827", "--primary": "#0070f3" },
    },
  ],
  DEFAULT_SKIN_ID: "universe",
}));

// Spy on jsonFetch so we can inspect the PATCH payload without a real HTTP call
vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn().mockResolvedValue({}),
}));

// Provide minimal TanStack Query stubs so the component renders without
// needing a real QueryClientProvider.
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
    useMutation: (opts: { mutationFn: (v: unknown) => Promise<unknown> }) => ({
      mutate: (vars: unknown, callbacks?: { onSuccess?: () => void }) => {
        // Call onSuccess synchronously so reset() state updates are observable.
        opts.mutationFn(vars).then(() => callbacks?.onSuccess?.());
      },
      isPending: false,
    }),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────
type BrandingInitial = {
  themePrimary: string | null;
  themeMode: "auto" | "dark" | "light" | null;
  logoUrl: string | null;
  defaultSkinId: string | null;
  brandName: string | null;
  agentName: string | null;
  tagline: string | null;
  wakeWord: string | null;
};

const BASE_INITIAL: BrandingInitial = {
  themePrimary: "#7C5CFF",
  themeMode: "auto",
  logoUrl: null,
  defaultSkinId: null,
  brandName: null,
  agentName: null,
  tagline: null,
  wakeWord: null,
};

function renderSection(overrides: Partial<BrandingInitial> = {}) {
  return render(
    <OrgBrandingSection orgId="org-123" initial={{ ...BASE_INITIAL, ...overrides }} />,
  );
}

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("OrgBrandingSection — org-branding fields", () => {
  it("renders the 4 identity text inputs", () => {
    renderSection();
    expect(screen.getByPlaceholderText("e.g. Acme Studio")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. Acme Helper")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. Build beautifully")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. Hey Acme")).toBeInTheDocument();
  });

  it("renders the org-default skin picker section", () => {
    renderSection();
    expect(
      screen.getByText(/Default skin for this organization/i),
    ).toBeInTheDocument();
    // AppearanceSkinPicker renders a button per skin by label
    expect(screen.getByText("Universe")).toBeInTheDocument();
    expect(screen.getByText("Pontis")).toBeInTheDocument();
  });

  it("does not render the removed Base preset buttons (redundant with Accent + mode)", () => {
    renderSection();
    expect(
      screen.queryByRole("button", { name: /Set base to/i }),
    ).not.toBeInTheDocument();
  });

  it("pre-populates inputs with values from initial props", () => {
    renderSection({
      brandName: "Acme Studio",
      agentName: "Acme Helper",
      tagline: "Build beautifully",
      wakeWord: "Hey Acme",
    });
    expect(screen.getByDisplayValue("Acme Studio")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Acme Helper")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Build beautifully")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Hey Acme")).toBeInTheDocument();
  });

  it("includes all 5 new fields in the PATCH payload on save", async () => {
    const { jsonFetch } = await import("@/lib/query/json-fetcher");
    const fetchMock = vi.mocked(jsonFetch);

    renderSection();

    // Fill in the identity inputs
    fireEvent.change(screen.getByPlaceholderText("e.g. Acme Studio"), {
      target: { value: "Acme Studio" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. Acme Helper"), {
      target: { value: "Acme Helper" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. Build beautifully"), {
      target: { value: "Build beautifully" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. Hey Acme"), {
      target: { value: "Hey Acme" },
    });

    // Select the "Pontis" skin (atelier)
    fireEvent.click(screen.getByRole("button", { name: /Pontis/i }));

    // Save
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save theme/i }));
    });

    expect(fetchMock).toHaveBeenCalled();
    const [, fetchOpts] = fetchMock.mock.calls[0];
    const payload = JSON.parse((fetchOpts as RequestInit).body as string);
    expect(payload).toMatchObject({
      brandName: "Acme Studio",
      agentName: "Acme Helper",
      tagline: "Build beautifully",
      wakeWord: "Hey Acme",
      defaultSkinId: "atelier",
    });
    // Legacy fields still present
    expect(payload).toHaveProperty("themePrimary");
    expect(payload).toHaveProperty("themeMode");
    expect(payload).toHaveProperty("logoUrl");
  });

  it("sends null for blank identity fields (inherit platform default)", async () => {
    const { jsonFetch } = await import("@/lib/query/json-fetcher");
    const fetchMock = vi.mocked(jsonFetch);

    renderSection({ brandName: "Existing" });

    // Clear the brandName
    fireEvent.change(screen.getByDisplayValue("Existing"), {
      target: { value: "" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save theme/i }));
    });

    const [, fetchOpts] = fetchMock.mock.calls[0];
    const payload = JSON.parse((fetchOpts as RequestInit).body as string);
    expect(payload.brandName).toBeNull();
  });

  it("includes all 8 fields in the reset payload", async () => {
    const { jsonFetch } = await import("@/lib/query/json-fetcher");
    const fetchMock = vi.mocked(jsonFetch);

    renderSection();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Reset to default/i }));
    });

    expect(fetchMock).toHaveBeenCalled();
    const [, fetchOpts] = fetchMock.mock.calls[0];
    const payload = JSON.parse((fetchOpts as RequestInit).body as string);
    expect(payload).toMatchObject({
      themePrimary: null,
      themeMode: null,
      logoUrl: null,
      defaultSkinId: null,
      brandName: null,
      agentName: null,
      tagline: null,
      wakeWord: null,
    });
  });
});
