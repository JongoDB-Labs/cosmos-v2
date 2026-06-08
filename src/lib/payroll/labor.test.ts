import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { laborCostFor, summarizeLabor } from "./labor";

const D = (s: string) => new Prisma.Decimal(s);

describe("laborCostFor", () => {
  it("multiplies hours × cost rate to cents", () => {
    expect(laborCostFor(8, D("50.00")).toString()).toBe("400");
    expect(laborCostFor(1.5, D("100")).toString()).toBe("150");
  });
  it("rounds half-even to cents", () => {
    expect(laborCostFor(0.333, D("100")).toString()).toBe("33.3");
    expect(laborCostFor(1, D("33.335")).toString()).toBe("33.34"); // half-even
  });
});

describe("summarizeLabor", () => {
  const rates = new Map([
    ["u1", D("100")],
    ["u2", D("50")],
  ]);

  it("groups cost by project at each user's rate", () => {
    const s = summarizeLabor(
      [
        { userId: "u1", projectId: "p1", hours: 2 }, // 200
        { userId: "u2", projectId: "p1", hours: 4 }, // 200
        { userId: "u1", projectId: "p2", hours: 1 }, // 100
      ],
      rates,
    );
    const p1 = s.byProject.find((g) => g.projectId === "p1")!;
    const p2 = s.byProject.find((g) => g.projectId === "p2")!;
    expect(p1.cost).toBe("400");
    expect(p2.cost).toBe("100");
    expect(s.total).toBe("500");
    expect(s.priced).toBe(3);
    expect(s.unpriced).toBe(0);
  });

  it("skips entries whose user has no cost rate (counts unpriced)", () => {
    const s = summarizeLabor(
      [
        { userId: "u1", projectId: "p1", hours: 1 }, // 100
        { userId: "ghost", projectId: "p1", hours: 5 }, // no rate → skipped
      ],
      rates,
    );
    expect(s.total).toBe("100");
    expect(s.priced).toBe(1);
    expect(s.unpriced).toBe(1);
  });

  it("buckets project-less labor under the null project", () => {
    const s = summarizeLabor([{ userId: "u2", projectId: null, hours: 3 }], rates);
    expect(s.byProject[0].projectId).toBeNull();
    expect(s.byProject[0].cost).toBe("150");
  });
});
