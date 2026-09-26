// @vitest-environment jsdom
//
// Picking a record type a PLUGIN contributed has to advance past the picker.
//
// The wizard draws its cards from the list the page hands it, which includes
// entities contributed by whichever plugins the org has switched on. But the
// step that decides what to render after a pick used to resolve the key against
// core's own registry, which by definition does not contain them. The card was
// therefore drawn, was clickable, and resolved to nothing — putting the picker
// straight back on screen, so the click read as not having registered. Nothing
// logged an error, and every unit test of the field definitions still passed.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { EntityDef } from "@/lib/import/entity-fields";
import { ImportWizard } from "@/components/import/import-wizard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/alpha/settings/import",
  useParams: () => ({ orgSlug: "alpha" }),
}));

/** Stands in for anything a plugin contributes: not in core's registry. */
const PLUGIN_ENTITY: EntityDef = {
  key: "timesheetRow",
  label: "Timesheet rows",
  icon: "Clock",
  blurb: "One row per person per week.",
  scope: "org",
  naturalKey: ["externalRef"],
  pluginSlug: "beta",
  fields: [
    { key: "externalRef", label: "Reference", kind: "text", required: true, synonyms: ["ref"] },
    { key: "hours", label: "Hours", kind: "number", synonyms: ["hours"] },
  ],
};

afterEach(cleanup);

describe("ImportWizard — plugin-contributed entities", () => {
  it("advances past the picker when one is chosen", () => {
    render(<ImportWizard orgId="org-1" orgSlug="alpha" entities={[PLUGIN_ENTITY]} />);

    fireEvent.click(screen.getByRole("button", { name: /Timesheet rows/i }));

    // The picker's own question is gone, the entity is named, and the way back
    // to the picker is on screen — i.e. the flow for this entity is up.
    expect(screen.queryByText(/What are you importing\?/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Change type/i })).toBeTruthy();
    expect(screen.getAllByText(/Timesheet rows/i).length).toBeGreaterThan(0);
  });

  it("offers every entity the page supplies, not core's list", () => {
    render(<ImportWizard orgId="org-1" orgSlug="alpha" entities={[PLUGIN_ENTITY]} />);

    const cards = screen.getAllByRole("button").filter((b) => /Timesheet rows/i.test(b.textContent ?? ""));
    expect(cards).toHaveLength(1);
  });

  it("does not offer the work-item flow without a project", () => {
    render(<ImportWizard orgId="org-1" orgSlug="alpha" entities={[PLUGIN_ENTITY]} />);

    expect(screen.queryByRole("button", { name: /Work Items/i })).toBeNull();
  });
});
