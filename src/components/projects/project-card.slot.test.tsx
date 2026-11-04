// @vitest-environment jsdom
//
// The `project.card` plugin slot: an ENABLED plugin's component renders on each
// card with that card's project, nothing renders otherwise, and one plugin
// throwing leaves the card (and every other contribution) standing.
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Blocks } from "lucide-react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/providers/permissions-provider", () => ({ usePermissions: () => ({ can: () => false }) }));

import { ProjectCard, type ProjectCardProject } from "./project-card";
import { PluginEnablementProvider } from "@/components/plugins/plugin-slot";
import { PluginRegistry, PLUGIN_API_VERSION, type PluginSlotProps } from "@/lib/plugins/registry";

function PhaseLine(p: PluginSlotProps["project.card"]) {
  return <span data-testid="phase">{`${p.orgId}|${p.projectId}|${p.projectKey}: Design development, 40%`}</span>;
}
function Broken(): never {
  throw new Error("plugin bug");
}

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const base = { apiVersion: PLUGIN_API_VERSION, description: "", icon: Blocks, version: "1.0.0", modules: [] };
  PluginRegistry.register({ ...base, slug: "phases", name: "Phases", slots: { "project.card": PhaseLine } });
  PluginRegistry.register({ ...base, slug: "broken", name: "Broken", slots: { "project.card": Broken } });
});
afterEach(cleanup);

const PROJECT: ProjectCardProject = {
  id: "p1",
  key: "RIVER",
  name: "Riverside Library",
  archived: false,
  updatedAt: "2026-10-01T00:00:00.000Z",
  totalItems: 10,
  doneItems: 4,
  percentComplete: 40,
  managers: [],
  activeIntervalName: null,
  nextDueDate: null,
};

function renderCard(enabled: string[]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginEnablementProvider orgs={[{ slug: "acme", enabledPlugins: enabled }]}>
        <ProjectCard project={PROJECT} orgSlug="acme" orgId="org1" />
      </PluginEnablementProvider>
    </QueryClientProvider>,
  );
}

describe("ProjectCard: project.card plugin slot", () => {
  it("renders an enabled plugin's contribution with this card's project", () => {
    renderCard(["phases"]);
    expect(screen.getByTestId("phase").textContent).toBe("org1|p1|RIVER: Design development, 40%");
  });

  it("renders nothing, and leaves no gap, when no contributing plugin is enabled", () => {
    const { container } = renderCard([]);
    expect(screen.queryByTestId("phase")).toBeNull();
    expect(container.querySelector('[data-slot="project.card"]')?.innerHTML).toBe("");
  });

  it("a contribution that throws renders nothing; the card and the other plugin survive", () => {
    renderCard(["broken", "phases"]);
    expect(screen.getByText("Riverside Library")).toBeTruthy();
    expect(screen.getByTestId("phase")).toBeTruthy();
  });
});
