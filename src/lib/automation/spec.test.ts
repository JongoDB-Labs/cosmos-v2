import { describe, it, expect } from "vitest";
import { Priority } from "@prisma/client";
import { automationSpecSchema, actionSchema, AUTOMATION_LIMITS } from "./spec";
import { renderTemplate, unknownNames } from "./template";
import { scheduleDue, triggerMatches } from "./trigger";

const ok = (spec: unknown) => automationSpecSchema.safeParse(spec).success;

describe("automationSpecSchema", () => {
  it("accepts a rule and fills its defaults", () => {
    const s = automationSpecSchema.parse({ trigger: { on: "item.created" }, actions: [{ kind: "assign", to: "triggerActor" }] });
    expect(s).toMatchObject({ scope: "trigger", options: { includeImports: false } });
  });

  it("refuses an unknown action, an extra key, and more actions than the limit", () => {
    expect(ok({ trigger: { on: "item.created" }, actions: [{ kind: "runScript", code: "x" }] })).toBe(false);
    expect(ok({ trigger: { on: "item.created" }, actions: [{ kind: "archive", url: "https://x" }] })).toBe(false);
    expect(ok({ trigger: { on: "item.created" }, actions: Array(AUTOMATION_LIMITS.actions + 1).fill({ kind: "archive" }) })).toBe(false);
  });

  it("takes a webhook by id, never by URL", () => {
    expect(actionSchema.safeParse({ kind: "webhook", webhookId: "00000000-0000-4000-8000-000000000001" }).success).toBe(true);
    expect(actionSchema.safeParse({ kind: "webhook", url: "http://169.254.169.254/" }).success).toBe(false);
  });

  it("keeps a scheduled rule to its own query", () => {
    const schedule = { on: "schedule", every: "day", hour: 9, cql: "status = todo" };
    expect(ok({ trigger: schedule, actions: [{ kind: "archive" }] })).toBe(true);
    expect(ok({ trigger: schedule, scope: "children", actions: [{ kind: "archive" }] })).toBe(false);
    expect(ok({ trigger: schedule, condition: { cql: "x = 1" }, actions: [{ kind: "archive" }] })).toBe(false);
    expect(ok({ trigger: schedule, actions: [{ kind: "assign", to: "triggerActor" }] })).toBe(false);
  });

  it("takes a query, a children check or both as its condition, but not an empty one", () => {
    const rule = (condition: unknown) => ({ trigger: { on: "item.transitioned" }, scope: "parent", condition, actions: [{ kind: "archive" }] });
    expect(ok(rule({ childrenAll: { categories: ["DONE", "CANCELLED"] } }))).toBe(true);
    expect(ok(rule({ cql: "priority = HIGH", childrenAll: { categories: ["DONE"] } }))).toBe(true);
    expect(ok(rule({}))).toBe(false);
    expect(ok(rule({ childrenAll: { categories: [] } }))).toBe(false);
    expect(ok(rule({ childrenAll: { categories: ["SHIPPED"] } }))).toBe(false);
  });

  it("offers exactly the priorities the database has", () => {
    const offered = (actionSchema.options[1] as { options: { shape: { field: { value: string }; value: { options: string[] } } }[] }).options
      .find((o) => o.shape.field.value === "priority")!.shape.value.options;
    expect([...offered].sort()).toEqual(Object.values(Priority).sort());
  });
});

describe("renderTemplate", () => {
  it("fills the names a sink allows and drops the rest", () => {
    expect(renderTemplate("{{item.key}} moved by {{ actor.name }}{{item.secret}}", "comment", { "item.key": "ENG-1", "actor.name": "Ana" })).toBe(
      "ENG-1 moved by Ana",
    );
    expect(unknownNames("{{item.key}} {{item.secret}}", "notification")).toEqual(["item.secret"]);
  });

  it("can't be made to render a second template from a value", () => {
    expect(renderTemplate("{{item.title}}", "comment", { "item.title": "{{rule.name}}" })).toBe("{ {rule.name}}");
  });
});

describe("triggerMatches", () => {
  const moved = (from: string, to: string, toCategory: string) => ({ type: "work_item.transitioned", payload: { from, to }, toCategory });

  it("matches a transition on its from, to and category", () => {
    expect(triggerMatches({ on: "item.transitioned", toCategory: ["DONE"] }, moved("doing", "done", "DONE"))).toBe(true);
    expect(triggerMatches({ on: "item.transitioned", toCategory: ["DONE"] }, moved("todo", "doing", "IN_PROGRESS"))).toBe(false);
    expect(triggerMatches({ on: "item.transitioned", from: ["todo"], to: ["doing"] }, moved("todo", "doing", "IN_PROGRESS"))).toBe(true);
    expect(triggerMatches({ on: "item.transitioned", from: ["review"] }, moved("todo", "doing", "IN_PROGRESS"))).toBe(false);
    expect(triggerMatches({ on: "item.created" }, moved("todo", "doing", "IN_PROGRESS"))).toBe(false);
  });

  it("matches an update only on a watched field, when it names some", () => {
    const e = { type: "work_item.updated", payload: { changes: { assigneeId: { from: null, to: "u" } } } };
    expect(triggerMatches({ on: "item.updated" }, e)).toBe(true);
    expect(triggerMatches({ on: "item.updated", fields: ["assigneeId"] }, e)).toBe(true);
    expect(triggerMatches({ on: "item.updated", fields: ["priority"] }, e)).toBe(false);
  });
});

describe("scheduleDue", () => {
  const daily = { on: "schedule" as const, every: "day" as const, hour: 9, minute: 30, cql: "x" };
  const at = (iso: string) => new Date(iso);

  it("is due once per slot, from the slot on", () => {
    expect(scheduleDue(daily, at("2026-10-24T09:29:00Z"), at("2026-10-23T09:30:00Z"))).toBe(false);
    expect(scheduleDue(daily, at("2026-10-24T09:30:00Z"), at("2026-10-23T09:30:00Z"))).toBe(true);
    expect(scheduleDue(daily, at("2026-10-24T15:00:00Z"), at("2026-10-24T09:30:05Z"))).toBe(false);
    expect(scheduleDue(daily, at("2026-10-24T08:00:00Z"), null)).toBe(true);
  });

  it("runs a weekly rule on Mondays", () => {
    const weekly = { ...daily, every: "week" as const };
    // 2026-10-26 is a Monday.
    expect(scheduleDue(weekly, at("2026-10-26T09:31:00Z"), at("2026-10-19T09:30:00Z"))).toBe(true);
    expect(scheduleDue(weekly, at("2026-10-25T23:00:00Z"), at("2026-10-19T09:30:00Z"))).toBe(false);
  });

  it("runs an hourly rule at its minute", () => {
    const hourly = { ...daily, every: "hour" as const, minute: 15 };
    expect(scheduleDue(hourly, at("2026-10-24T10:16:00Z"), at("2026-10-24T09:15:00Z"))).toBe(true);
    expect(scheduleDue(hourly, at("2026-10-24T10:14:00Z"), at("2026-10-24T09:15:00Z"))).toBe(false);
  });
});
