// A dashboard widget draws the board's widget bag and fetches nothing itself.
//
// That is the whole access-control argument for widgets: the dashboard loads
// its project's items, sprints and members through the gated routes ONCE, and
// every widget reads what those routes returned to this viewer, narrowed by the
// board's filter bar. A widget that fetched for itself would answer to its own
// gate — or to none — and would escape the filter bar too.
//
// So this is a fact about every file in this directory, not about one widget:
// no fetch, no query hook, no database, and no import from outside a short list
// of modules that are pure. A widget added later is covered without anyone
// remembering to extend a list.
//
// ONE EXEMPTION, by name: the Quick Action widget renders the shared
// `NewWorkItemButton`, whose dialog reads the projects list and posts the new
// item through the same gated routes every board's "New work item" uses. It
// fetches nothing to DRAW; it is a button for the user to act through.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join("src", "components", "boards", "dashboard", "widgets");

/** Imports a widget file may make: rendering, formatting and the widget bag. */
const ALLOWED_IMPORTS = new Set([
  "react",
  "next/link",
  "lucide-react",
  "@/lib/utils",
  "@/lib/format/stable-date",
  "@/lib/boards/widget-registry",
  "@/lib/boards/widget-data",
  "@/lib/boards/widget-definitions",
  "@/components/charts/lazy-recharts",
  // Backticks, not quotes: `src/types/exports-are-reachable.arch.test.ts`
  // counts every QUOTED mention of this module as an import statement, and an
  // allowlist entry is not one.
  `@/types/models`,
  // The shared "is this item settled" rules, for the strikethroughs
  // (`resolved-strikethrough.arch.test.ts`). Pure, no fetching.
  "@/lib/work-items/done-state",
  // Query KEYS and the client, for invalidating the board's own items after
  // the Quick Action creates one. Not a fetch (the hooks are refused below).
  "@/lib/query/keys",
  "@tanstack/react-query",
]);

const EXEMPT: Record<string, string[]> = {
  "content-widgets.tsx": ["@/components/boards/shared/new-work-item-button"],
};

const FORBIDDEN = [
  /\bfetch\s*\(/,
  /\bjsonFetch\b/,
  /\buse(Suspense)?(Infinite)?Quer(y|ies)\s*\(/,
  /\buse(Org)?Mutation\s*\(/,
  /\bprisma\b/,
  /\bEventSource\b/,
  /\bWebSocket\b/,
];

/** Comments out, so prose that NAMES a fetch does not trip (or satisfy) this. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const files = readdirSync(DIR)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
  .map((f) => ({ name: f, src: code(readFileSync(join(DIR, f), "utf8")) }));

describe("dashboard widgets draw the bag and fetch nothing", () => {
  it("scans the widget files (positive control)", () => {
    const names = files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["board-widgets.tsx", "list-widgets.tsx", "time-widgets.tsx"]));
    // …and the forbidden patterns do match what they are meant to.
    expect(FORBIDDEN.some((re) => re.test("const r = await fetch(url)"))).toBe(true);
    expect(FORBIDDEN.some((re) => re.test("useQuery({ queryKey })"))).toBe(true);
  });

  it("calls no fetch, query hook or database", () => {
    const hits = files.flatMap((f) =>
      FORBIDDEN.filter((re) => re.test(f.src)).map((re) => `${f.name}: ${re}`),
    );
    expect(hits).toEqual([]);
  });

  it("imports only pure modules, plus the one named exemption", () => {
    const outside = files.flatMap((f) =>
      [...f.src.matchAll(/from\s+"([^"]+)"/g)]
        .map((m) => m[1])
        .filter((spec) => !spec.startsWith("./"))
        .filter((spec) => !ALLOWED_IMPORTS.has(spec))
        .filter((spec) => !(EXEMPT[f.name] ?? []).includes(spec))
        .map((spec) => `${f.name} imports ${spec}`),
    );
    expect(outside).toEqual([]);
  });
});
