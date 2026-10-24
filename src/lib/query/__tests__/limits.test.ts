// The bound-parameter budget: Prisma binds each `in` / `notIn` value separately.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));
import { listValues, MAX_LIST_VALUES } from "../execute.server";

describe("listValues", () => {
  it("counts every in / notIn value, at any depth, and nothing else", () => {
    const where = {
      AND: [
        { id: { in: ["a", "b"] } },
        { OR: [{ NOT: { id: { notIn: ["c"] } } }, { activities: { some: { newValue: { in: ["x", "y", "z"] } } } }] },
        { createdAt: { gte: new Date() } },
        { title: { contains: "in" } },
      ],
    };
    expect(listValues(where)).toBe(6);
  });

  it("stays well under Postgres' ~32,766 bound parameters", () => {
    expect(MAX_LIST_VALUES).toBeLessThan(32_766);
  });
});
