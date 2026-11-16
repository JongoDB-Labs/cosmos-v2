// @vitest-environment node
//
// What a confirm-class preview counts as its targets. Every `…Id` argument used
// to count, so a call was previewed with the project (and team) it names as
// targets beside the one thing it acts on.
import { describe, it, expect } from "vitest";
import { namedTargetIds } from "../confirmation";
import { cosmosTools } from "../tools";
import { isConfirmClass } from "../confirm-class";

const P = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";

const def = (name: string) => {
  const d = cosmosTools.find((t) => t.name === name);
  if (!d) throw new Error(`no tool ${name}`);
  return d;
};

describe("a confirm-class call's targets", () => {
  it("are the ids its tool declares, not the project or team it names", () => {
    expect(namedTargetIds({ projectId: P, boardId: B }, def("delete_board").confirmTargets)).toEqual([B]);
    expect(namedTargetIds({ projectId: P, teamId: T, userId: U, isLead: true }, def("add_team_member").confirmTargets)).toEqual([U]);
    expect(namedTargetIds({ viewId: B, visibility: "TEAM", projectId: P, teamId: T }, def("share_saved_view").confirmTargets)).toEqual([B]);
  });

  it("control: the same arguments, with no declaration, count every id (what a plugin's tool still gets)", () => {
    expect(namedTargetIds({ projectId: P, boardId: B })).toEqual([P, B].sort());
    expect(namedTargetIds({ projectId: P, teamId: T, userId: U, isLead: true })).toEqual([P, T, U].sort());
  });

  it("a declared argument may carry a list", () => {
    expect(namedTargetIds({ itemIds: [U, B, U], projectId: P }, ["itemIds"])).toEqual([U, B].sort());
  });

  it("every core confirm-class tool but the bulk one declares its targets, each a required argument", () => {
    const tools = cosmosTools.filter(isConfirmClass).filter((t) => t.name !== "bulk_update_work_items");
    expect(tools.length).toBeGreaterThan(15);
    for (const t of tools) {
      const schema = t.input_schema as { properties?: Record<string, unknown>; required?: string[] };
      expect(t.confirmTargets?.length, t.name).toBeGreaterThan(0);
      for (const a of t.confirmTargets ?? []) {
        expect(Object.keys(schema.properties ?? {}), `${t.name}.${a}`).toContain(a);
        expect(schema.required ?? [], `${t.name}.${a}`).toContain(a);
      }
    }
  });

  it("the bulk tool declares none: it resolves its selection as its executor does", () => {
    expect(def("bulk_update_work_items").confirmTargets).toBeUndefined();
  });
});
