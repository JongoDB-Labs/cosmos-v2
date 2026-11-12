import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toast } from "sonner";
import { copyLinkAction } from "./item-actions";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * Comments and exports in `src/lib/work-items` that a nightly sweep found
 * describing something other than the code they sit on (CLEANUP-31).
 *
 * Read as SOURCE TEXT on purpose. Every finding here is a claim a reader
 * believes and the compiler cannot check: a doc block attached to the wrong
 * function, a catch comment promising behaviour the code does not have, an
 * exported interface nothing imports that has quietly drifted from the contract
 * it claims to describe. `tsc` is green for all of them, which is exactly why
 * they survived long enough to be swept up — so the ratchet has to read the
 * file.
 */

const HERE = __dirname;

function read(rel: string): string {
  return readFileSync(join(HERE, rel), "utf8");
}

/** Source with comments removed, so a word in prose never counts as a use. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("board-filters: each doc block sits on the function it describes", () => {
  it("the 'satisfies a board's filters?' block is matchesFilters', not the interval helper's", () => {
    // The block was stranded above `inIntervalSelection`, which has its own doc
    // block directly underneath — so the first thing a reader met was a
    // description of the WRONG function (its optional parameters, its
    // BoardFilters type-import), and `matchesFilters` itself read as
    // undocumented.
    const src = read("board-filters.ts");
    const at = src.indexOf("Does one work item satisfy a board's filters?");
    expect(at, "the matchesFilters doc block is gone entirely").toBeGreaterThan(-1);
    const next = src.slice(at).match(/^(?:export )?(?:async )?function (\w+)/m);
    expect(next?.[1]).toBe("matchesFilters");
  });
});

describe("item-actions: the catch comment claims no behaviour the code lacks", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { origin: "https://cosmos.example" } });
  });

  it("an insecure origin DOES still toast success — the premise of the finding", () => {
    // `navigator.clipboard` is undefined on an insecure origin, so
    // `navigator.clipboard?.writeText(...)` short-circuits to undefined instead
    // of throwing: the catch is never entered and the success toast fires over
    // an empty clipboard. Pinned rather than fixed — changing the copy path is
    // a behaviour change, out of scope for a comment sweep — so that the
    // comment below can be held to what the code actually does.
    vi.mocked(toast.success).mockClear();
    vi.stubGlobal("navigator", {});
    const [action] = copyLinkAction({ id: "w1" }, "acme");
    action.onClick!();
    expect(toast.success).toHaveBeenCalledWith("Work item link copied");
  });

  it("does not promise the toast is suppressed on an insecure origin", () => {
    const src = read("item-actions.ts");
    expect(src).not.toMatch(/no toast lies/);
    expect(src).not.toMatch(/insecure origin/);
  });
});

describe("query/project: permissions are a decimal string, not a BigInt", () => {
  it("no comment calls OrgMember.permissions a BigInt", () => {
    // `prisma/schema.prisma` declares `permissions String @default("0")` — the
    // bitfield has bits >= 63, which overflow Postgres BIGINT — and AGENTS.md
    // records that the BigInt-serialisation crash class is gone. The rule the
    // comments carry ("this projection never selects permissions") is still
    // true and stays; only the reason given for it was false.
    const offenders = read("query/project.ts")
      .split("\n")
      .filter((l) => /permissions/i.test(l) && /BigInt/.test(l));
    expect(offenders).toEqual([]);
  });
});

describe("query/scope: no import the file does not use", () => {
  it("imports only identifiers that appear in the body", () => {
    // `Permission, hasPermission` were imported and never referenced: the
    // per-project decision is made by `evaluateAccess` and `isOrgAdministrator`,
    // so the import read as though a raw bit check happened here too.
    const src = read("query/scope.ts");
    const body = code(src).replace(/import[\s\S]*?from\s+"[^"]+";?/g, "");
    const unused: string[] = [];
    for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"[^"]+";?/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
        if (name && !new RegExp(`\\b${name}\\b`).test(body)) unused.push(name);
      }
    }
    expect(unused).toEqual([]);
  });
});

describe("schedule-impact: the route contract owns the response shape", () => {
  it("declares no SchedulePreview interface beside it", () => {
    // Nothing imported it, and it had already drifted: it omits the
    // `allocation` array the route returns, so its "What the preview endpoint
    // answers" was false. The contract's zod `responses[200]` is the one
    // source of truth.
    expect(read("schedule-impact.ts")).not.toMatch(/\bSchedulePreview\b/);
  });

  it("…and that contract really does declare allocation", () => {
    const contract = readFileSync(
      join(
        HERE,
        "../../app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/schedule-preview/route.contract.ts",
      ),
      "utf8",
    );
    expect(contract).toMatch(/allocation/);
  });
});

describe("apply-change / workflow engine: boardId is not carried for nobody", () => {
  it("ApplyChangeInput no longer accepts it", () => {
    // It was read only to be forwarded to `gateChange`, which never read it:
    // hard WIP limits hold from every surface, so the field had been inert
    // since that change and its own comment said so.
    const src = read("apply-change.server.ts");
    const iface = src.slice(src.indexOf("export interface ApplyChangeInput"));
    expect(iface.slice(0, iface.indexOf("\n}"))).not.toMatch(/\bboardId\b/);
    expect(src).not.toMatch(/input\.boardId/);
  });

  it("gateChange no longer declares it", () => {
    const src = readFileSync(join(HERE, "../workflow/engine.server.ts"), "utf8");
    const start = src.indexOf("export async function gateChange(");
    expect(start, "gateChange moved or was renamed").toBeGreaterThan(-1);
    const sig = src.slice(start, src.indexOf("): Promise<GateResult>", start));
    expect(sig).not.toMatch(/\bboardId\b/);
  });
});
