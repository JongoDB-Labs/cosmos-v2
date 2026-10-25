// @vitest-environment node
// (e2e DB) Drill-down agrees with the chart: for every group a panel shows,
// listing the items behind it finds exactly as many as the panel counted:
// named groups, the empty group, "Other", matrix cells and time buckets.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { seedWorld, type World } from "@/lib/query/__tests__/cql-fixture";
import { parseCql } from "@/lib/query/parser";
import { computePanels, drillPanel, type PanelResult, type PanelSpec } from "../panel-data.server";

let w: World;
const NOW = new Date("2026-10-12T15:00:00Z");
const opts = { tz: "UTC", now: NOW };
type Row = { keys: { id: string | null }[]; count: number; value: number };

function data(r: PanelResult) {
  if ("error" in r) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r as { data: Record<string, unknown>; meta: { total: number | null; cql?: string } };
}

beforeAll(async () => {
  w = await seedWorld();
}, 60_000);
afterAll(async () => {
  await w?.cleanup();
});

async function everySliceAgrees(spec: PanelSpec) {
  const ctx = w.ctx({ denyP3: true });
  const [panel] = await computePanels(ctx, [spec], opts);
  const rows = data(panel).data.rows as Row[];
  expect(rows.length).toBeGreaterThan(0);
  const shown = [0, 1].map((i) => rows.map((r) => r.keys[i]?.id).filter((x): x is string => !!x));
  for (const r of rows) {
    const slice = { keys: r.keys.map((k) => k.id), exclude: shown };
    const drilled = data(await drillPanel(ctx, spec, slice, { ...opts, limit: 100 }));
    expect(drilled.meta.total, JSON.stringify(r.keys)).toBe(r.count);
  }
}

describe("drill-down", () => {
  const P1 = () => parseCql(`project = ${w.P1.key}`).query;

  it.each(["priority", "assignee", "status", "sprint", "label", "statusCategory", "team"])("breakdown by %s", async (field) => {
    await everySliceAgrees({ type: "breakdown", query: P1(), config: { field: { kind: "sys", id: field } } });
  });

  it("the Other group lists exactly what it folded", async () => {
    await everySliceAgrees({ type: "breakdown", query: P1(), config: { field: { kind: "sys", id: "priority" }, limit: 2 } });
  });

  it("matrix cells and stacked bars", async () => {
    await everySliceAgrees({ type: "stacked", query: P1(), config: { x: { kind: "sys", id: "assignee" }, y: { kind: "sys", id: "priority" } } });
  });

  it("workload counts open work only, and so does its drill", async () => {
    await everySliceAgrees({ type: "workload", query: P1(), config: { unit: "count" } });
  });

  it("a time bucket lists the items completed in it", async () => {
    const ctx = w.ctx({ denyP3: true });
    const spec = { type: "created-vs-resolved", query: P1(), config: { window: "-30d", bucket: "day" } };
    const [panel] = await computePanels(ctx, [spec], { tz: "UTC", now: new Date() });
    const points = data(panel).data.points as { bucket: string; resolved: number }[];
    const day = points.find((p) => p.resolved > 0)!;
    const drilled = data(await drillPanel(ctx, spec, { keys: [day.bucket], series: "resolved" }, { tz: "UTC", now: new Date() }));
    expect(drilled.meta.total).toBe(day.resolved);
  });

  it("a number drills to everything it counted; lists don't drill", async () => {
    const ctx = w.ctx({ denyP3: true });
    const spec = { type: "number", query: parseCql("priority = CRITICAL").query, config: {} };
    const n = data((await computePanels(ctx, [spec], opts))[0]).data.value;
    expect(data(await drillPanel(ctx, spec, { keys: [] }, opts)).meta.total).toBe(n);
    const list = await drillPanel(ctx, { type: "item-list", query: null, config: {} }, { keys: [] }, opts);
    expect("error" in list && list.error.code).toBe("PANEL_NO_DRILL");
  });
});
