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

  it("no tool answers a powerless caller the same way it answers an owner", async () => {
    const indifferent: string[] = [];

    for (const tool of cosmosTools) {
      if (tool.name in EXEMPT || CONNECTOR_TOOLS.has(tool.name)) continue;
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
