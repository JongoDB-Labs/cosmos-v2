import { describe, it, expect } from "vitest";
import { Prisma, ProjectStatus } from "@prisma/client";
import type { z } from "zod";
import * as common from "../schemas/common";

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

describe("enum copies match Prisma", () => {
  // Written out in common.ts so contract files need no @prisma/client.
  it("ProjectStatus", () => {
    expect([...common.PROJECT_STATUSES]).toEqual(Object.values(ProjectStatus));
  });
});
