import { describe, it, expect } from "vitest";
import { contractModules } from "../contracts.generated";
import { buildDocument, collectContracts } from "../registry";
import { API_KEY_SCOPES } from "@/lib/auth/api-key-scopes";

/**
 * House rules for the published spec, checked on the generated document
 * itself (what Spectral would lint, without its dependency tree). Every
 * operation must be usable from the reference alone: who may call it, what it
 * returns, and how it fails.
 */
type Op = {
  operationId?: string; summary?: string; tags?: string[];
  security?: Record<string, string[]>[];
  parameters?: { $ref?: string }[];
  "x-cosmos-scopes"?: string[]; "x-cosmos-stability"?: string;
  responses: Record<string, { content?: Record<string, { schema: { $ref?: string; type?: string; items?: { $ref?: string } } }> }>;
};

const doc = buildDocument(collectContracts(contractModules), "public") as unknown as {
  paths: Record<string, Record<string, Op>>;
};
const ops = Object.entries(doc.paths).flatMap(([p, methods]) =>
  Object.entries(methods).map(([m, op]) => ({ where: `${m.toUpperCase()} ${p}`, op })));

describe("published spec lint", () => {
  it("has operations", () => {
    expect(ops.length).toBeGreaterThan(0);
  });

  it.each(ops)("$where: id, summary, tag, stability", ({ op }) => {
    expect(op.operationId).toMatch(/^[a-z][A-Za-z0-9]+$/);
    expect(op.summary).toBeTruthy();
    expect(op.tags?.length).toBeGreaterThan(0);
    expect(["stable", "beta"]).toContain(op["x-cosmos-stability"]);
  });

  it.each(ops)("$where: security names real scopes, the same ones as x-cosmos-scopes", ({ op }) => {
    expect(op.security).toEqual([{ bearerPat: op["x-cosmos-scopes"] }]);
    for (const s of op["x-cosmos-scopes"] ?? []) expect(API_KEY_SCOPES).toContain(s);
  });

  it.each(ops)("$where: takes Cosmos-API-Version", ({ op }) => {
    expect(op.parameters).toContainEqual({ $ref: "#/components/parameters/ApiVersion" });
  });

  it.each(ops)("$where: documents 401 (and 403 when it needs scopes), and every error is a Problem", ({ op }) => {
    expect(Object.keys(op.responses)).toContain("401");
    if (op["x-cosmos-scopes"]?.length) expect(Object.keys(op.responses)).toContain("403");
    for (const [status, r] of Object.entries(op.responses)) {
      if (Number(status) < 400) continue;
      expect(r.content?.["application/problem+json"]?.schema.$ref).toBe("#/components/schemas/Problem");
    }
  });

  it.each(ops)("$where: a success body is a named component (or a list of one), never an anonymous object", ({ op }) => {
    for (const [status, r] of Object.entries(op.responses)) {
      if (Number(status) >= 400 || !r.content) continue;
      const s = r.content["application/json"].schema;
      const ref = s.$ref ?? (s.type === "array" ? s.items?.$ref : undefined);
      expect(ref, `${status} should reference #/components/schemas/…`).toMatch(/^#\/components\/schemas\//);
    }
  });
});
