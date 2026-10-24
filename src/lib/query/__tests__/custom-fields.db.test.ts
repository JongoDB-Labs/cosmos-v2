// (e2e DB) Custom fields: `IS EMPTY` and `~` (query design phase 4).
//
// "Empty" has four spellings in a JSON column: the key was never set, it is
// JSON null, or it was cleared to "" or []. All four are empty; nothing else is.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { executeCql } from "../execute.server";
import { seedWorld, type World } from "./cql-fixture";

describe("CQL custom fields (e2e DB)", () => {
  let w: World;
  let notes: string;
  let tags: string;
  beforeAll(async () => {
    w = await seedWorld();
    notes = `notes_${w.stamp}`;
    tags = `tags_${w.stamp}`;
    await prisma.customField.create({ data: { orgId: w.orgA, key: notes, name: `Notes ${w.stamp}`, fieldType: "TEXT" } });
    await prisma.customField.create({ data: { orgId: w.orgA, key: tags, name: `Areas ${w.stamp}`, fieldType: "MULTI_SELECT", options: ["web", "api"] } });
    let n = 300;
    const item = (title: string, customFields: Record<string, unknown>) =>
      prisma.workItem.create({
        data: {
          orgId: w.orgA, projectId: w.P1.id, ticketNumber: n++, title, description: "", columnKey: "todo",
          workItemTypeId: w.typeTask, createdById: w.actor.id, customFields: customFields as Prisma.InputJsonValue,
        },
      });
    await item("cf-absent", {});
    await item("cf-null", { [notes]: null, [tags]: null });
    await item("cf-cleared", { [notes]: "", [tags]: [] });
    await item("cf-text", { [notes]: "Customer ACME asked for 100% uptime", [tags]: ["web"] });
    await item("cf-other", { [notes]: "nothing to see", [tags]: ["api", "web"] });
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  const titles = async (cql: string) =>
    (await executeCql(w.ctx(), { cql: `text ~ "cf-" AND (${cql})` }, { pageSize: 100 })).data.map((r) => r.title).sort();
  const f = (key: string) => `cf[${key}]`;

  it("IS EMPTY: never set, null, or cleared; IS NOT EMPTY is the rest", async () => {
    expect(await titles(`${f(notes)} IS EMPTY`)).toEqual(["cf-absent", "cf-cleared", "cf-null"]);
    expect(await titles(`${f(notes)} IS NOT EMPTY`)).toEqual(["cf-other", "cf-text"]);
    expect(await titles(`${f(tags)} IS EMPTY`)).toEqual(["cf-absent", "cf-cleared", "cf-null"]);
    expect(await titles(`${f(tags)} IN (api, EMPTY)`)).toEqual(["cf-absent", "cf-cleared", "cf-null", "cf-other"]);
  });

  it("!= / NOT IN leave empty values out, as on system fields", async () => {
    expect(await titles(`${f(tags)} NOT IN (api)`)).toEqual(["cf-text"]);
    expect(await titles(`${f(tags)} NOT IN (api) OR ${f(tags)} IS EMPTY`)).toEqual(["cf-absent", "cf-cleared", "cf-null", "cf-text"]);
  });

  it("~ on text fields: contains, any case, wildcards literal, * as a prefix", async () => {
    expect(await titles(`${f(notes)} ~ "acme"`)).toEqual(["cf-text"]);
    expect(await titles(`${f(notes)} ~ "%"`)).toEqual(["cf-text"]);
    expect(await titles(`${f(notes)} ~ "_"`)).toEqual([]);
    expect(await titles(`${f(notes)} ~ "nothing*"`)).toEqual(["cf-other"]);
    expect(await titles(`${f(notes)} ~ "see*"`)).toEqual([]);
    // Like !=, !~ leaves out items where the field is empty.
    expect(await titles(`${f(notes)} !~ "acme"`)).toEqual(["cf-other"]);
  });
});
