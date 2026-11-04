// @vitest-environment jsdom
//
// The New project form under an org numbering standard: the next number is
// shown, but left for the SERVER to allocate unless the person changes it, so
// two people creating at once can't both submit the number they were shown.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/new",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { ProjectMetadataStep } from "./project-metadata-step";

let numbering: Record<string, unknown>;
const posted: Record<string, unknown>[] = [];

beforeEach(() => {
  posted.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/project-numbering")) return new Response(JSON.stringify(numbering));
      if (url.endsWith("/projects") && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ key: "RIVER" }), { status: 201 });
      }
      return new Response("{}");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderStep() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectMetadataStep orgId="org1" orgSlug="acme" templateId={null} sector={null} onBack={() => {}} />
    </QueryClientProvider>,
  );
}

const typeName = (v: string) => fireEvent.change(screen.getByPlaceholderText("My Project"), { target: { value: v } });
const create = () => fireEvent.click(screen.getByRole("button", { name: "Create project" }));

describe("New project: project number", () => {
  it("shows the next number and previews the name, but lets the server allocate it", async () => {
    numbering = { pattern: "YY-NNN", namePattern: "{number} {name}", next: "26-005" };
    renderStep();
    const field = await screen.findByLabelText("Project number");
    expect(field).toHaveValue("26-005");
    typeName("Riverside Library");
    expect(screen.getByText("26-005 Riverside Library")).toBeTruthy();
    create();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).not.toHaveProperty("number");
  });

  it("sends a number the person typed", async () => {
    numbering = { pattern: "YY-NNN", namePattern: null, next: "26-005" };
    renderStep();
    fireEvent.change(await screen.findByLabelText("Project number"), { target: { value: "26-100" } });
    typeName("Riverside Library");
    create();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].number).toBe("26-100");
  });

  it("no standard: no number field, nothing sent", async () => {
    numbering = { pattern: null, namePattern: null, next: null };
    renderStep();
    typeName("Riverside Library");
    create();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(screen.queryByLabelText("Project number")).toBeNull();
    expect(posted[0]).not.toHaveProperty("number");
  });
});
