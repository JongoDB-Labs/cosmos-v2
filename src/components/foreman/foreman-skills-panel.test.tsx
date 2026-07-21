// @vitest-environment jsdom
//
// Foreman skills manager card — mirrors the mocking idiom from
// foreman-supervisor-panel.test.tsx (mock next/navigation + sonner +
// @/lib/errors/notify + @/lib/query/json-fetcher, wrap in a fresh
// QueryClientProvider per test): GET the list on mount, POST
// {mode:"create", ...} to add a skill (Compose or Paste both funnel into
// the same create call — Paste just pre-fills the Compose fields via the
// pure parseSkillMarkdown parser).
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

function renderSkills() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForemanSkillsPanel orgId="org-1" />
    </QueryClientProvider>,
  );
}

function postCalls() {
  const postUrl = "/api/v1/orgs/org-1/foreman/skills";
  return holder.calls.filter((c) => c.url === postUrl && c.method === "POST");
}

describe("ForemanSkillsPanel", () => {
  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
    holder.skills = oneSkill();
  });

  it("lists a skill returned by GET", async () => {
    renderSkills();
    expect(await screen.findByText("cosmos-architecture")).toBeInTheDocument();
    expect(screen.getByText("How the codebase is laid out.")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
  });

  it("Compose mode: filling fields and clicking Add POSTs create with the fields", async () => {
    renderSkills();
    await screen.findByText("cosmos-architecture");

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "cosmos-x" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "does x" } });
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: "# X" } });
    fireEvent.click(screen.getByRole("button", { name: /add skill/i }));

    await waitFor(() =>
      expect(postCalls().some((c) => (c.body as { name?: string; description?: string; body?: string })?.name === "cosmos-x" && (c.body as { name?: string; description?: string; body?: string })?.body === "# X")).toBe(
        true,
      ),
    );
    const call = postCalls().find((c) => (c.body as { name?: string; description?: string; body?: string })?.name === "cosmos-x");
    expect(call?.body).toMatchObject({
      mode: "create",
      name: "cosmos-x",
      description: "does x",
      body: "# X",
      orgScope: true,
    });
  });

  it("Paste mode: pasting a SKILL.md fills the fields, then Add POSTs create", async () => {
    renderSkills();
    await screen.findByText("cosmos-architecture");

    fireEvent.click(screen.getByRole("button", { name: /paste/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /paste/i }), {
      target: { value: "---\nname: pasted-skill\ndescription: from paste\n---\n# Body here" },
    });
    fireEvent.click(screen.getByRole("button", { name: /fill from paste/i }));

    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe("pasted-skill");

    fireEvent.click(screen.getByRole("button", { name: /add skill/i }));
    await waitFor(() => expect(postCalls().some((c) => (c.body as { name?: string; description?: string; body?: string })?.name === "pasted-skill")).toBe(true));
  });

  it("Paste mode: an invalid SKILL.md (no name) shows an inline error and does not fill", async () => {
    renderSkills();
    await screen.findByText("cosmos-architecture");

    fireEvent.click(screen.getByRole("button", { name: /paste/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /paste/i }), {
      target: { value: "just some plain prose, nothing structured" },
    });
    fireEvent.click(screen.getByRole("button", { name: /fill from paste/i }));

    // Only the inline error <p> should match — the pasted textarea content
    // itself is deliberately free of the string "name" so this can't
    // false-collide with the textarea's own text node.
    expect(screen.getByText(/no .?name/i)).toBeInTheDocument();
  });

  it("no longer renders a separate Import button", async () => {
    renderSkills();
    await screen.findByText("cosmos-architecture");
    expect(screen.queryByRole("button", { name: /^import$/i })).not.toBeInTheDocument();
  });
});
