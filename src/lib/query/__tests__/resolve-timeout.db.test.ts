// @vitest-environment node
// (e2e DB) The resolver's own id-set reads (ancestor / descendantsOf walks,
// milestone links) run under the statement budget, like every other read the
// query layer makes. /cql/validate reaches them, so one deep tree or one big
// milestone must not be able to run unbounded.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { OrgRole } from "@prisma/client";
import { seedWorld, type World } from "./cql-fixture";

const seen = vi.hoisted(() => ({ budgets: [] as number[], insideBudget: new Set<string>() }));
vi.mock("../timeout.server", async (orig) => {
  const real = (await orig()) as typeof import("../timeout.server");
  return {
    withStatementTimeout: (ms: number, fn: Parameters<typeof real.withStatementTimeout>[1]) =>
      real.withStatementTimeout(ms, (tx) => {
        seen.budgets.push(ms);
        // Record what the callback reads through the budgeted transaction.
        const spy = new Proxy(tx, {
          get(target, key, recv) {
            if (typeof key === "string" && (key === "$queryRaw" || key === "milestoneLink")) seen.insideBudget.add(key);
            return Reflect.get(target, key, recv);
          },
        });
        return fn(spy);
      }),
  };
});

import { prepareCql } from "../execute.server";

describe("resolver reads run under the statement budget (e2e DB)", () => {
  let w: World;
  beforeAll(async () => {
    w = await seedWorld();
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  it("the hierarchy walk and the milestone links are read inside withStatementTimeout", async () => {
    seen.budgets.length = 0;
    seen.insideBudget.clear();
    const admin = w.ctx({ role: OrgRole.ADMIN });
    await prepareCql(admin, { cql: `ancestor = ${w.P1.key}-1 OR milestone IS EMPTY` }, { timeoutMs: 1_234 });
    expect(seen.budgets).toContain(1_234);
    expect([...seen.insideBudget].sort()).toEqual(["$queryRaw", "milestoneLink"]);
  });
});
