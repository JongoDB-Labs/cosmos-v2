import { describe, it, expect } from "vitest";
import { classifyRisk } from "./risk";

const clean = { files: ["src/components/x.tsx"], additions: 20, deletions: 5 };

describe("classifyRisk", () => {
  it("passes a small, non-sensitive change", () => {
    expect(classifyRisk(clean).gated).toBe(false);
  });
  it("gates a Prisma migration", () => {
    const r = classifyRisk({ files: ["prisma/migrations/20260101_x/migration.sql"], additions: 3, deletions: 0 });
    expect(r.gated).toBe(true);
    expect(r.reasons.join()).toMatch(/migration|schema/i);
  });
  it("gates a schema edit", () => {
    expect(classifyRisk({ files: ["prisma/schema.prisma"], additions: 2, deletions: 0 }).gated).toBe(true);
  });
  it("gates sensitive paths (auth, rbac, egress, deploy, workflows, Dockerfile, next.config)", () => {
    for (const f of ["src/lib/auth/session.ts", "src/lib/rbac/check.ts", "src/lib/abac/rule.ts", "src/lib/ai/egress/provider.ts", "Dockerfile", "next.config.ts", ".deploy/x.sh", ".github/workflows/y.yml"]) {
      expect(classifyRisk({ files: [f], additions: 1, deletions: 0 }).gated).toBe(true);
    }
  });
  it("gates an over-budget diff by files", () => {
    expect(classifyRisk({ files: Array.from({ length: 9 }, (_, i) => `src/a${i}.ts`), additions: 10, deletions: 0 }).gated).toBe(true);
  });
  it("gates an over-budget diff by lines", () => {
    expect(classifyRisk({ files: ["src/a.ts"], additions: 350, deletions: 100 }).gated).toBe(true);
  });
});
