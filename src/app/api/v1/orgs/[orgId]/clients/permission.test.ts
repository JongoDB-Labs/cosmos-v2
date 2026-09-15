import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A client is a CRM entity and must be gated like one.
 *
 * This route was the only member of the CRM family reaching for a PROJECT
 * permission: `contracts`, `partners` and `products` all use CRM_READ /
 * CRM_CREATE, and `clients` used PROJECT_READ / PROJECT_UPDATE.
 *
 * It matters because the payload carries contact data — legalName, email,
 * phone, notes. PROJECT_READ is included in the `read` API-key scope, which the
 * key reference describes as "read projects, items, comments, OKRs, sprints".
 * So a key issued for work tracking could also enumerate every client and their
 * contact details, which is not what choosing that scope agrees to. Found by
 * auditing a real key against production on 2026-09-15: every other sensitive
 * surface (payroll, employees, bank accounts, invoices, audit logs) correctly
 * returned 403, and `clients` returned 200.
 *
 * Source-level, and comparative rather than absolute: the property worth
 * holding is "gated like its siblings", which survives a future rename of the
 * permission itself.
 */

const read = (p: string) =>
  readFileSync(join(process.cwd(), "src/app/api/v1/orgs/[orgId]", p, "route.ts"), "utf8");

const perms = (src: string) => [...new Set(src.match(/Permission\.[A-Z_]+/g) ?? [])].sort();

describe("clients is gated like the rest of CRM", () => {
  it("uses CRM permissions, not PROJECT ones", () => {
    const p = perms(read("clients"));
    expect(p).toContain("Permission.CRM_READ");
    expect(p).toContain("Permission.CRM_CREATE");
    expect(p).not.toContain("Permission.PROJECT_READ");
    expect(p).not.toContain("Permission.PROJECT_UPDATE");
  });

  it("matches what its siblings use — the comparison that makes this durable", () => {
    // If CRM permissions are ever renamed, this keeps holding; an absolute
    // assertion on the name would not.
    const siblings = ["contracts", "partners", "products"].map((s) => perms(read(s)));
    const clients = perms(read("clients"));
    for (const sib of siblings) {
      for (const permission of sib) {
        expect(clients, `sibling grants ${permission}`).toContain(permission);
      }
    }
  });

  it("the sibling comparison is reading real files — the control", () => {
    // Without this, a typo'd path would make the loop above iterate nothing and
    // pass vacuously.
    const contracts = perms(read("contracts"));
    expect(contracts.length).toBeGreaterThan(0);
    expect(contracts).toContain("Permission.CRM_READ");
  });

  it("you cannot create a client you are not allowed to list", () => {
    // The GET and POST gates must come from the same family, or a caller can
    // write rows it can never read back.
    const src = read("clients");
    const family = (m: RegExpMatchArray | null) => m?.[1]?.split("_")[0];
    const get = family(src.slice(src.indexOf("export async function GET")).match(/Permission\.([A-Z_]+)/));
    const post = family(src.slice(src.indexOf("export async function POST")).match(/Permission\.([A-Z_]+)/));
    expect(get).toBe(post);
  });
});
