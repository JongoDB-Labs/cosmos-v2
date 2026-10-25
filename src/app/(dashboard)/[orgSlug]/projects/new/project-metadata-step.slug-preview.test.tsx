// @vitest-environment jsdom
//
// The new-project wizard used to render a live "Slug: my-project" preview under
// the name field. Nothing consumed it: `model Project` has no slug column, the
// POST /projects body is {name,key,description,templateId,sector}, and the
// wizard's own success handler routes to `/${orgSlug}/projects/${key}`. So the
// preview promised the user an identifier the app neither stores nor uses —
// next to the Project key field, which is the identifier that IS real.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/new",
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

import { ProjectMetadataStep } from "./project-metadata-step";

afterEach(cleanup);

function renderStep() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProjectMetadataStep
        orgId="org1"
        orgSlug="acme"
        templateId={null}
        sector={null}
        onBack={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("the new-project metadata step", () => {
  it("shows no slug preview once a name is typed", () => {
    const { container } = renderStep();

    fireEvent.change(screen.getByPlaceholderText("My Project"), {
      target: { value: "Apollo Rewrite" },
    });

    expect(container.textContent).not.toContain("Slug:");
    expect(container.textContent).not.toContain("apollo-rewrite");
  });

  it("still derives the project KEY from the name — that identifier is real", () => {
    renderStep();

    fireEvent.change(screen.getByPlaceholderText("My Project"), {
      target: { value: "Apollo Rewrite" },
    });

    expect(screen.getByPlaceholderText("PROJ")).toHaveValue("APOLLO");
  });
});
