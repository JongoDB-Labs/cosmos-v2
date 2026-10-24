import { describe, it, expect } from "vitest";
import { Prisma, $Enums } from "@prisma/client";
import type { z } from "zod";
import * as common from "../schemas/common";
import * as E from "../schemas/enums.generated";

/**
 * Response schemas are projections: a column they don't declare is a column
 * the API stops returning. That is right for a column nobody should see, and
 * a silent outage for one the UI reads. The first draft of `Project` lost
 * `enabledFeatures` (the board tabs) exactly that way. So every entity schema
 * must name every scalar column of its model, or list it in OMITTED with the
 * reason it is withheld.
 */
const ENTITIES: Record<string, { model: string; omitted: Record<string, string> }> = {
  Project: { model: "Project", omitted: {} },
  Board: { model: "Board", omitted: {} },
  BoardColumn: { model: "BoardColumn", omitted: {} },
  Interval: { model: "Interval", omitted: {} },
  ProjectMember: { model: "ProjectMember", omitted: {} },
  WorkItem: {
    model: "WorkItem",
    omitted: {
      searchVector: "full-text index internals",
    },
  },
  MilestoneLink: { model: "MilestoneLink", omitted: {} },
  Milestone: { model: "Milestone", omitted: {} },
  Member: {
    model: "OrgMember",
    omitted: {
      permissions: "a raw permission mask (AGENTS.md: never in a payload)",
      abacRules: "authorization internals",
      removedAt: "the list shows memberships, not their history",
    },
  },
  Label: { model: "Label", omitted: {} },
  WorkItemType: { model: "WorkItemType", omitted: {} },
  CustomField: { model: "CustomField", omitted: {} },
};

const models = Prisma.dmmf.datamodel.models;
const scalarColumns = (model: string) =>
  models.find((m) => m.name === model)!.fields
    .filter((f) => f.kind !== "object" && f.kind !== "unsupported")
    .map((f) => f.name);

describe.each(Object.entries(ENTITIES))("%s schema", (name, { model, omitted }) => {
  const shape = (common as unknown as Record<string, z.ZodObject<z.ZodRawShape>>)[name].shape;

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
