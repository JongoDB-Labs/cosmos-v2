// @vitest-environment node
//
// A caller's PERMISSIONS must change what every offered tool does.
//
// This is the "RBAC-scoped access" property stated as a request rather than
// assumed: Cosmo acts entirely as the logged-in user, so a caller holding an
// empty permission mask must not be able to reach what an OWNER can.
//
// ## Why this is a DIFFERENTIAL and not "does it refuse?"
//
// The obvious version of this test — call every tool with a powerless caller
// and assert it returns an error — passes vacuously. Called with empty
// arguments almost every tool fails input validation, and a validation error
// is indistinguishable from a permission refusal. Written that way, this file
// passed with a real `assertPermission` gate deliberately neutralised: the tool
// still errored, just for a different reason. It proved tools reject `{}`.
//
// So each tool runs TWICE with identical arguments, varying only the caller.
// If the powerless and the omnipotent caller get the same answer, the caller's
// permissions made no difference, which is the defect — whatever the answer
// was. That version does catch the neutralised gate.
import { describe, it, expect } from "vitest";
import { cosmosTools } from "@/lib/ai/tools";
import { executeTool } from "@/lib/ai/tool-executor";
import { Permission } from "@/lib/rbac/permissions";
import { stubToolCtx } from "@/lib/testing/tool-auth";
import { connectorToolDefs } from "@/lib/ai/connectors";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { OrgRole } from "@prisma/client";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const USER = "00000000-0000-0000-0000-0000000000b2";

/** Every permission bit the product defines. */
const ALL = Object.values(Permission).reduce((a, b) => a | b, 0n);

/**
 * EXTERNAL connector tools are out of scope here, and deliberately so rather
 * than by oversight.
 *
 * They are dispatched ahead of the native switch by the connector registry,
 * which refuses outright when the connector was not offered for this run — so
 * in a test with no connectors configured, every caller gets the same upstream
 * refusal and this differential learns nothing about them. Their authorization
 * is a different mechanism (registry offering, per-connector credentials, the
 * gov/commercial split) and wants its own test; it is NOT covered by this file.
 *
 * Computed from the registry, so a new connector is excluded automatically
 * instead of silently failing this test.
 */
const CONNECTOR_TOOLS = new Set(connectorToolDefs().map((t) => t.name));

const powerless = () => stubToolCtx(ORG, USER);
const omnipotent = () =>
  stubToolCtx(ORG, USER, { permissions: ALL, basePermissions: ALL, orgRole: "OWNER" as OrgRole });

/**
 * Tools whose answer may legitimately not depend on org permissions, each
 * because it reaches NO org data. Adding a name here claims the tool can
 * neither read nor change anything belonging to the tenant — make that claim
 * only after reading the executor.
 */
const EXEMPT: Record<string, string> = {
  process_transcript:
    "A stub: returns a fixed sentence saying transcript work happens at the " +
    "chat level. Reads nothing, writes nothing. If it grows a real " +
    "implementation it must take a gate and come off this list.",
  fetch_url:
    "Fetches an EXTERNAL url and returns its text. Touches no tenant data; its " +
    "own risk is SSRF, handled by `webhookUrlSchema`, not by RBAC.",
};

/**
 * AUTHORIZES_AFTER_PARSE — tools this differential cannot judge, and why.
 *
 * These tools authorize against a PROJECT, and the project id is an INPUT. So
 * authorization necessarily follows `safeParse`, and this probe calls every
 * tool with `{}` — which fails parse for both callers, giving identical
 * answers. The indifference is an artefact of the probe, not of the tool.
 *
 * This is NOT the `EXEMPT` claim above: these tools absolutely do reach tenant
 * data. The claim here is narrower — that the differential is the wrong
 * instrument — so it is only acceptable because two other rules cover them:
 *
 *   - `project-scope.arch.test.ts` → "every tool file that takes a projectId
 *     gates on it" requires `assertProjectRead|assertProjectManage` in the
 *     body, so a gate DELETED from one of these is still caught (per function,
 *     not per file).
 *   - `write-authority.test.ts` drives the gate behaviourally with
 *     `requireProjectManage` mocked, asserting the bit matches the route's and
 *     that a project manager is admitted.
 *
 * The tempting repairs are both wrong, and both were tried: pre-checking the
 * org-wide WRITE bit short-circuits `requireProjectManage`'s manager branch,
 * and pre-checking the surface's READ bit invents a gate the route does not
 * have. Either would turn this test green by making the product wrong.
 *
 * Adding a name here obliges you to confirm it is covered by BOTH rules above.
 */
const AUTHORIZES_AFTER_PARSE = new Set([
  "create_risk", "update_risk", "create_blocker", "update_blocker",
  "create_deliverable", "update_deliverable",
  "create_change_request", "update_change_request",
  "create_milestone", "update_milestone", "delete_milestone",
  "create_goal", "update_goal", "create_kpi", "update_kpi",
]);

/**
 * AUTHORIZES_AFTER_ROW_READ — the same artefact, a different cause.
 *
 * `set_feedback_status` authorizes against the ITEM'S AUTHOR: the route gates a
 * status change with `requireAccess(ctx, "ORG_UPDATE", { createdById })`, so the
 * subject is a column on a row named by an input. The row cannot be read before
 * the input is parsed, so — exactly as in the set above — a `{}` probe fails
 * parse for both callers.
 *
 * Mirroring the route is the POINT here, not a concession: `PUT /feedback/[id]`
 * has NO permission gate before reading the row either. It authenticates, reads,
 * checks project visibility, parses, and only then authorizes. Putting a
 * pre-parse gate in the executor to satisfy this differential would invent an
 * authority the portal does not have — the same mistake the note above records.
 *
 * Covered instead by `feedback.test.ts` → "status triage needs org-settings
 * permission", which drives a REAL MEMBER from the database against a real row
 * and asserts the row does not move. Mutation-proven: weakening the gate back
 * to ITEM_UPDATE fails exactly those specs.
 */
const AUTHORIZES_AFTER_ROW_READ = new Set(["set_feedback_status"]);

async function run(name: string, ctx: ReturnType<typeof powerless>): Promise<string> {
  try {
    return JSON.stringify(await executeTool(name, {}, ctx)) ?? "undefined";
  } catch (e) {
    return `THREW:${(e as Error).message}`;
  }
}

describe("a caller's permissions change what every tool does", () => {
  it("has native tools to check", () => {
    // Guards the guard: if the registry were empty, or connectors grew to cover
    // everything, every case below would pass vacuously.
    const native = cosmosTools.filter((t) => !CONNECTOR_TOOLS.has(t.name) && !(t.name in EXEMPT));
    expect(native.length).toBeGreaterThan(50);
  });

  it("every exemption names a tool that is actually offered", () => {
    const offered = new Set(cosmosTools.map((t) => t.name));
    expect(Object.keys(EXEMPT).filter((n) => !offered.has(n))).toEqual([]);
  });

  it("every AUTHORIZES_AFTER_PARSE entry names an offered tool", () => {
    // Same guard EXEMPT gets: a renamed tool must not silently keep its pass.
    const offered = new Set(cosmosTools.map((t) => t.name));
    expect([...AUTHORIZES_AFTER_PARSE].filter((n) => !offered.has(n))).toEqual([]);
  });

  it("every AUTHORIZES_AFTER_PARSE tool really does gate, per the OTHER rule", () => {
    // The exemption above is only honest while this holds. Checked here, in the
    // same file as the exemption, so the two cannot drift apart: each listed
    // tool's executor must still forward to `assertProjectManage`.
    const dir = join(process.cwd(), "src/lib/ai/executors");
    const src = readdirSync(dir)
      .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    expect(src).toContain("assertProjectManage");
    // And nothing listed may have lost its gate wholesale: the count of
    // assertProjectManage call sites must cover every exempted tool.
    const calls = src.match(/assertProjectManage\(/g)?.length ?? 0;
    expect(calls).toBeGreaterThanOrEqual(AUTHORIZES_AFTER_PARSE.size);
  });

  it("the row-read exemption still forwards to the route's own gate", () => {
    // The exemption is honest only while this holds. Asserted HERE, beside the
    // claim, so the two cannot drift: the executor must still call
    // `requireAccess` with ORG_UPDATE rather than naming a bit of its own.
    const src = readFileSync(
      join(process.cwd(), "src/lib/ai/executors/feedback.ts"),
      "utf8",
    );
    expect([...AUTHORIZES_AFTER_ROW_READ]).toEqual(["set_feedback_status"]);
    expect(src).toContain("requireAccess(auth,");
    expect(src).toContain('"ORG_UPDATE"');
    // And NOT the MEMBER-held bit this was fixed away from.
    expect(src).not.toContain('requireAccess(auth, "ITEM_UPDATE"');
  });

  it("no tool answers a powerless caller the same way it answers an owner", async () => {
    const indifferent: string[] = [];

    for (const tool of cosmosTools) {
      if (tool.name in EXEMPT || CONNECTOR_TOOLS.has(tool.name)) continue;
      if (AUTHORIZES_AFTER_PARSE.has(tool.name)) continue;
      if (AUTHORIZES_AFTER_ROW_READ.has(tool.name)) continue;
      const [weak, strong] = [await run(tool.name, powerless()), await run(tool.name, omnipotent())];
      if (weak === strong) indifferent.push(`${tool.name} → ${weak.slice(0, 90)}`);
    }

    expect(
      indifferent,
      "These tools answered identically whether the caller held every permission " +
        "or none, so nothing they do depends on the caller's role. Gate through " +
        "assertPermission/assertProjectRead in `_ctx.ts` BEFORE validating input, " +
        "or document an exemption above.",
    ).toEqual([]);
  }, 120_000);
});
