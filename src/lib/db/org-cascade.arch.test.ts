import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deleting an organization must actually delete that organization's rows.
 *
 * Prisma only emits a foreign key when a model DECLARES the relation. A model
 * that carries a bare `orgId` scalar and no `Organization` relation compiles,
 * typechecks, and queries correctly — and then silently survives
 * `prisma.organization.delete`, because there is no constraint for Postgres to
 * cascade. 48 models had drifted into exactly that state, stranding work items,
 * boards, comments, time entries, invoices, payroll and contracts in the
 * database after a tenant was deleted.
 *
 * TypeScript cannot catch this (the scalar is a perfectly valid field), and no
 * unit test would either — every app query is org-scoped, so orphans are
 * invisible until someone counts rows. Hence an arch test.
 *
 * This also guards plugins: a plugin adding an org-scoped model inherits the
 * rule, since its models land in the same schema after composition.
 */
const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

/**
 * `audit_logs` keeps a deliberately FK-less `orgId`: it is the tombstone that
 * must OUTLIVE the org it describes, which is what the delete handler relies on
 * to record `org.deleted`. It is the only legitimate exception — adding another
 * means arguing that some other data should survive its tenant.
 */
const INTENTIONALLY_FK_LESS = new Set(["AuditLog"]);

function models(): { name: string; body: string }[] {
  return [...schema.matchAll(/^model (\w+) \{(.*?)^\}/gms)].map((m) => ({
    name: m[1],
    body: m[2],
  }));
}

const orgScoped = () =>
  models().filter((m) => /^\s*orgId\s/m.test(m.body) && !INTENTIONALLY_FK_LESS.has(m.name));

describe("org-scoped models cascade on org delete", () => {
  it("every model with an orgId declares an Organization relation", () => {
    const missing = orgScoped()
      .filter((m) => !/^\s+\w+\s+Organization\??\s+@relation/m.test(m.body))
      .map((m) => m.name);

    expect(
      missing,
      `These models have an orgId with no Organization relation, so Prisma emits no ` +
        `foreign key and their rows SURVIVE a tenant delete. Add:\n` +
        `  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)\n` +
        `(use Organization? when orgId is nullable — those rows are global/built-in).`,
    ).toEqual([]);
  });

  it("every such relation cascades rather than restricting or nulling", () => {
    const wrong = orgScoped()
      .map((m) => ({
        name: m.name,
        rel: /^\s+\w+\s+Organization\??\s+@relation\(([^)]*)\)/m.exec(m.body)?.[1],
      }))
      .filter((m) => m.rel && !m.rel.includes("onDelete: Cascade"))
      .map((m) => m.name);

    expect(
      wrong,
      "These declare an Organization relation but do not cascade, so an org delete " +
        "will either fail or strand rows with a dangling orgId.",
    ).toEqual([]);
  });

  it("keeps the audit-log tombstone exempt on purpose, not by accident", () => {
    const auditLog = models().find((m) => m.name === "AuditLog");
    expect(auditLog, "AuditLog model not found — update this test if it was renamed").toBeTruthy();
    expect(/^\s*orgId\s/m.test(auditLog!.body)).toBe(true);
    expect(/^\s+\w+\s+Organization\??\s+@relation/m.test(auditLog!.body)).toBe(false);
  });
});
