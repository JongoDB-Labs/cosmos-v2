import { describe, it, expect } from "vitest";
import { Prisma, $Enums } from "@prisma/client";
import type { z } from "zod";
import * as common from "../schemas/common";
import * as E from "../schemas/enums.generated";
import * as okr from "../schemas/okr";
import * as goals from "../schemas/goals";
import * as time from "../schemas/time";
import * as audit from "../schemas/audit";
import * as workItems from "../schemas/work-items";
import * as links from "../schemas/links";

/**
 * Response schemas are projections: a column they don't declare is a column
 * the API stops returning. That is right for a column nobody should see, and
 * a silent outage for one the UI reads. The first draft of `Project` lost
 * `enabledFeatures` (the board tabs) exactly that way. So every entity schema
 * must name every scalar column of its model, or list it in OMITTED with the
 * reason it is withheld.
 */
type Entity = { schema: z.ZodObject<z.ZodRawShape>; model: string; omitted: Record<string, string> };

const ENTITIES: Record<string, Entity> = {
  Project: { schema: common.Project, model: "Project", omitted: {} },
  Board: { schema: common.Board, model: "Board", omitted: {} },
  BoardColumn: { schema: common.BoardColumn, model: "BoardColumn", omitted: {} },
  Interval: { schema: common.Interval, model: "Interval", omitted: {} },
  ProjectMember: { schema: common.ProjectMember, model: "ProjectMember", omitted: {} },
  WorkItem: {
    schema: common.WorkItem,
    model: "WorkItem",
    omitted: {
      searchVector: "full-text index internals",
    },
  },
  MilestoneLink: { schema: common.MilestoneLink, model: "MilestoneLink", omitted: {} },
  Milestone: { schema: common.Milestone, model: "Milestone", omitted: {} },
  Member: {
    schema: common.Member,
    model: "OrgMember",
    omitted: {
      permissions: "a raw permission mask (AGENTS.md: never in a payload)",
      abacRules: "authorization internals",
      removedAt: "the list shows memberships, not their history",
    },
  },
  Label: { schema: common.Label, model: "Label", omitted: {} },
  WorkItemType: { schema: common.WorkItemType, model: "WorkItemType", omitted: {} },
  CustomField: { schema: common.CustomField, model: "CustomField", omitted: {} },
  ...okr.entities,
  ...goals.entities,
  ...time.entities,
  ...audit.entities,
  ...workItems.entities,
  ...links.entities,
};

const models = Prisma.dmmf.datamodel.models;
const scalarColumns = (model: string) =>
  models.find((m) => m.name === model)!.fields
    .filter((f) => f.kind !== "object" && f.kind !== "unsupported")
    .map((f) => f.name);

describe.each(Object.entries(ENTITIES))("%s schema", (_name, { schema, model, omitted }) => {
  const shape = schema.shape;

  it(`declares every scalar column of ${model}, or withholds it on purpose`, () => {
    const missing = scalarColumns(model).filter((c) => !(c in shape) && !(c in omitted));
    expect(missing, "add these to the schema, or to OMITTED with the reason").toEqual([]);
  });

  it("withholds only columns that exist", () => {
    expect(Object.keys(omitted).filter((c) => !scalarColumns(model).includes(c))).toEqual([]);
  });
});

describe("enums.generated.ts matches Prisma", () => {
  // Prisma 7's DMMF carries no enums; the generated client's $Enums does.
  const runtime = Object.entries($Enums as Record<string, Record<string, string>>);

  it("has every Prisma enum, and only those", () => {
    expect(Object.keys(E).sort()).toEqual(runtime.map(([n]) => n).sort());
  });

  it.each(runtime)("%s", (name, values) => {
    expect([...(E as Record<string, readonly string[]>)[name]]).toEqual(Object.values(values));
  });
});
