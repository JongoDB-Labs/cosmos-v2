// CLEANUP-10 and CLEANUP-19: dead surface under src/app/(dashboard).
//
// Every item here is code that could not run: a prop
// nothing read, a branch nothing could reach, a `loading.tsx` identical to the
// one the parent already renders in the same slot. None of it can be pinned by
// driving the UI — that is exactly the property that let it survive. So pin it
// structurally: these assertions fail the moment the dead shape comes back.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dash = join(root, "src/app/(dashboard)/[orgSlug]");
const read = (rel: string) => readFileSync(join(dash, rel), "utf8");

/** Comments explain what was removed, and naming it there must not read as the
 *  thing still being present. */
const stripComments = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("settings per-segment loading.tsx", () => {
  // settings/layout.tsx renders {children}; no intermediate layout exists
  // between it and these segments, so a per-segment loading.tsx wraps the SAME
  // slot the parent already wraps — with a byte-identical skeleton. The parent
  // alone covers them, as account-security/ and api-keys/ already relied on.
  const redundant = [
    "ai",
    "agent-policy",
    "agent-governance",
    "audit-logs",
    "classifications",
    "compliance",
  ];

  it("defers to the section-level skeleton", () => {
    for (const seg of redundant) {
      expect(existsSync(join(dash, "settings", seg, "loading.tsx"))).toBe(false);
    }
  });

  it("keeps the section-level skeleton that covers them", () => {
    expect(read("settings/loading.tsx")).toContain("PageSkeleton");
    // If an intermediate layout ever appears, a per-segment loading.tsx stops
    // being redundant and this whole rule needs revisiting.
    expect(existsSync(join(dash, "settings/ai/layout.tsx"))).toBe(false);
  });
});

describe("project board tabs", () => {
  const tabs = read("projects/[projectKey]/board-tabs.tsx");
  const layout = read("projects/[projectKey]/layout.tsx");

  it("no longer takes a prop it never destructured", () => {
    // layout.tsx computed project.projectTemplate.defaultConfig, passed it in,
    // and the component dropped it on the floor.
    expect(tabs).not.toContain("templateDefaultConfig");
    expect(layout).not.toContain("templateDefaultConfig");
    // ...so the query no longer joins the template just to feed it.
    expect(layout).not.toContain("projectTemplate");
  });

  it("wraps every tab in the actions menu unconditionally", () => {
    // buildTabGroups always pushes the Move group and the Hide group, so
    // `groups.length > 0` was always true and the bare-link fallback was
    // unreachable. A `groups.length` test here would be re-introducing it.
    expect(stripComments(tabs)).not.toMatch(/groups\.length/);
    expect(tabs).toContain("triggerLabel={`Tab actions for ${tab.label}`}");
  });
});

describe("project import page", () => {
  it("does not filter on a required relation", () => {
    // OrgMember.user is a required relation (prisma/schema.prisma), so Prisma
    // types and returns it non-nullable — the filter could never drop a row.
    expect(read("projects/[projectKey]/import/page.tsx")).not.toContain(
      ".filter((m) => m.user)",
    );
  });
});

describe("new-project template picker", () => {
  const picker = read("projects/new/template-picker.tsx");

  it("has no no-sector arms", () => {
    // Step 2 of the wizard is only reachable from handleSectorSelect's
    // else-branch, i.e. with a sector chosen. The null arms were unreachable.
    expect(picker).not.toContain('sector ?? "all"');
    expect(picker).not.toContain("Choose any template");
    expect(picker).toContain("sector: string;");
  });

  it("always scopes the request and the cache key to that sector", () => {
    expect(picker).toContain('useOrgQueryKey("project-templates", sector)');
    expect(picker).toContain("?sector=${encodeURIComponent(sector)}");
  });
});

describe("docblocks that described code that was not there", () => {
  it("drops the dependencies page's async-child claim", () => {
    const src = read("projects/[projectKey]/dependencies/page.tsx");
    // The default export IS the async component — there is no child.
    expect(src).not.toContain("dynamic reads live in");
    expect(src).toContain("FR a36d8f16"); // the useful half stays
  });

  it("drops the project page's phantom return contract", () => {
    const src = read("projects/[projectKey]/page.tsx");
    // tryDefaultTab is declared `: void`; no call site reads a result.
    expect(src).not.toContain("Returns true when");
    expect(src).toContain("const tryDefaultTab = (defaultTab: string | null): void =>");
  });
});
