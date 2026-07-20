// @vitest-environment jsdom
//
// Foreman skills manager card — mirrors the mocking idiom from
// foreman-supervisor-panel.test.tsx (mock next/navigation + sonner +
// @/lib/errors/notify + @/lib/query/json-fetcher, wrap in a fresh
// QueryClientProvider per test): GET the list on mount, POST
// {mode:"create"|"import", ...} to add a skill.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/foreman",
  useParams: () => ({ orgSlug: "acme" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

interface SkillRow {
  id: string;
  orgId: string | null;
  name: string;
  description: string;
  enabled: boolean;
  source: string;
}

function oneSkill(): SkillRow[] {
  return [
    {
      id: "skill-1",
      orgId: null,
      name: "cosmos-architecture",
      description: "How the codebase is laid out.",
      enabled: true,
      source: "authored",
    },
  ];
}

const holder: {
  skills: SkillRow[];
  calls: { url: string; method?: string; body?: unknown }[];
} = {
  skills: oneSkill(),
  calls: [],
};

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string, opts?: { method?: string; body?: string }) => {
    holder.calls.push({
      url,
      method: opts?.method,
      body: opts?.body ? JSON.parse(opts.body) : undefined,
    });
    if (opts?.method === "POST") {
      return Promise.resolve({ id: "new-skill" });
    }
    if (opts?.method === "PATCH" || opts?.method === "DELETE") {
      return Promise.resolve({});
    }
    return Promise.resolve({ skills: holder.skills });
  }),
}));

import { ForemanSkillsPanel } from "./foreman-skills-panel";

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForemanSkillsPanel orgId="org-1" />
    </QueryClientProvider>,
  );
}

describe("ForemanSkillsPanel", () => {
  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
    holder.skills = oneSkill();
  });

  it("lists a skill returned by GET", async () => {
    renderPanel();
    expect(await screen.findByText("cosmos-architecture")).toBeInTheDocument();
    expect(screen.getByText("How the codebase is laid out.")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
  });

  it("submitting the Create form POSTs {mode:'create', name, description, body, orgScope}", async () => {
    renderPanel();
    await screen.findByText("cosmos-architecture");

    fireEvent.change(screen.getByLabelText("Skill name"), { target: { value: "My New Skill" } });
    fireEvent.change(screen.getByLabelText("Skill description"), {
      target: { value: "A test skill." },
    });
    fireEvent.change(screen.getByLabelText("Skill body"), {
      target: { value: "# My New Skill\n\nBody." },
    });

    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    const postUrl = "/api/v1/orgs/org-1/foreman/skills";
    await waitFor(() =>
      expect(holder.calls.some((c) => c.url === postUrl && c.method === "POST")).toBe(true),
    );
    const call = holder.calls.find((c) => c.url === postUrl && c.method === "POST");
    expect(call?.body).toMatchObject({
      mode: "create",
      name: "My New Skill",
      description: "A test skill.",
      body: "# My New Skill\n\nBody.",
      orgScope: true,
    });
  });

  it("submitting the Import form POSTs {mode:'import', body, orgScope}", async () => {
    renderPanel();
    await screen.findByText("cosmos-architecture");

    const md = "---\nname: imported-skill\ndescription: Imported.\n---\n\nBody.\n";
    fireEvent.change(screen.getByLabelText("SKILL.md to import"), { target: { value: md } });
    fireEvent.click(screen.getByRole("button", { name: /^import$/i }));

    const postUrl = "/api/v1/orgs/org-1/foreman/skills";
    await waitFor(() =>
      expect(holder.calls.some((c) => c.url === postUrl && c.method === "POST")).toBe(true),
    );
    const call = holder.calls.find((c) => c.url === postUrl && c.method === "POST");
    expect(call?.body).toMatchObject({ mode: "import", body: md, orgScope: true });
  });
});
