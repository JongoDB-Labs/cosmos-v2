// src/lib/classification/__tests__/conservative-ceiling.db.test.ts
// @vitest-environment node
//
// `conservativeCeiling` against the REAL database (no prisma mock).
//
// Why a DB-backed case when the unit tests already cover the semantics: the
// read-path egress fix rests on one claim about a QUERY — that
// `findMany({ where: { orgId } })` returns the org-ceiling row AND every
// per-project row — and a hand-written prisma double cannot test that claim, only
// restate it. This asserts it against Postgres, with the ROW COUNT as the positive
// control so an insert that silently failed shows up as a count, not as a
// reassuring UNCLASSIFIED over an empty table.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { conservativeCeiling, effectiveCeiling } from "../effective";

const SUFFIX = Math.random().toString(36).slice(2, 10);
const APPLIED_BY = "99999999-9999-4999-8999-999999999999";

let orgId = "";
let cuiProjectId = "";
let openProjectId = "";

describe("conservativeCeiling — against the real data_classifications table", () => {
  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `ceiling-${SUFFIX}`, slug: `ceiling-${SUFFIX}`, tenantClass: "COMMERCIAL" },
    });
    orgId = org.id;
    const cui = await prisma.project.create({ data: { orgId, name: "high", key: `HI${SUFFIX}` } });
    const open = await prisma.project.create({ data: { orgId, name: "open", key: `OP${SUFFIX}` } });
    cuiProjectId = cui.id;
    openProjectId = open.id;
    // Exactly the configuration the defect needed: org UNCLASSIFIED, one project CUI.
    await prisma.dataClassification.create({
      data: { orgId, projectId: null, level: "UNCLASSIFIED", appliedById: APPLIED_BY },
    });
    await prisma.dataClassification.create({
      data: { orgId, projectId: cuiProjectId, level: "CUI", appliedById: APPLIED_BY },
    });
    await prisma.dataClassification.create({
      data: { orgId, projectId: openProjectId, level: "UNCLASSIFIED", appliedById: APPLIED_BY },
    });
  });

  afterAll(async () => {
    if (orgId) await prisma.organization.delete({ where: { id: orgId } }); // cascades
  });

  it("the fixture really exists (positive control: three rows, one per scope)", async () => {
    const rows = await prisma.dataClassification.findMany({ where: { orgId }, select: { projectId: true, level: true } });
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.projectId === null)).toHaveLength(1);
  });

  it("effectiveCeiling still answers PER PROJECT — the semantics other callers rely on", async () => {
    await expect(effectiveCeiling(orgId)).resolves.toBe("UNCLASSIFIED");               // org row alone
    await expect(effectiveCeiling(orgId, openProjectId)).resolves.toBe("UNCLASSIFIED"); // the low project
    await expect(effectiveCeiling(orgId, cuiProjectId)).resolves.toBe("CUI");           // the high one
  });

  it("conservativeCeiling returns CUI for the org — with no project argument at all", async () => {
    // The defect in one assertion: this is what a read tool carrying no (or a decoy)
    // projectId is now gated at, where it used to be gated at UNCLASSIFIED.
    await expect(conservativeCeiling(orgId)).resolves.toBe("CUI");
  });

  it("an org with ONLY an org-ceiling row is unchanged (the blast-radius bound)", async () => {
    const plain = await prisma.organization.create({
      data: { name: `ceiling-plain-${SUFFIX}`, slug: `ceiling-plain-${SUFFIX}`, tenantClass: "COMMERCIAL" },
    });
    try {
      await prisma.dataClassification.create({
        data: { orgId: plain.id, projectId: null, level: "UNCLASSIFIED", appliedById: APPLIED_BY },
      });
      await expect(conservativeCeiling(plain.id)).resolves.toBe("UNCLASSIFIED");
      await expect(effectiveCeiling(plain.id)).resolves.toBe("UNCLASSIFIED");
    } finally {
      await prisma.organization.delete({ where: { id: plain.id } });
    }
  });

  it("an org with NO rows defaults to UNCLASSIFIED, not PUBLIC", async () => {
    const empty = await prisma.organization.create({
      data: { name: `ceiling-empty-${SUFFIX}`, slug: `ceiling-empty-${SUFFIX}`, tenantClass: "COMMERCIAL" },
    });
    try {
      await expect(conservativeCeiling(empty.id)).resolves.toBe("UNCLASSIFIED");
    } finally {
      await prisma.organization.delete({ where: { id: empty.id } });
    }
  });
});
