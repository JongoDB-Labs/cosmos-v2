import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  contractFiles, operationKey, readInternalRoutes, scanOperations,
} from "../../../scripts/openapi/routes.mjs";
import { contractModules } from "./contracts.generated";
import { buildDocument, collectContracts } from "./registry";
import { isRouteContract } from "./contract";

/**
 * The contract pipeline's invariants. Each failure message says what to run
 * or change; `npm run openapi` regenerates everything derived.
 */

const contracts = collectContracts(contractModules);
const operations = scanOperations();
const opKeys = new Set(operations.map((o) => o.key));
const contractKeys = contracts.map((c) => operationKey(c.method, c.path));

describe("every v1 operation has a contract or is on the internal-routes ratchet", () => {
  const listed = readInternalRoutes();

  it("no operation is missing from both", () => {
    const covered = new Set([...contractKeys, ...listed]);
    const missing = [...opKeys].filter((k) => !covered.has(k));
    expect(missing, "give these a route.contract.ts (stability \"internal\" keeps them out of the public spec)")
      .toEqual([]);
  });

  it("the list names nothing that has a contract or no longer exists (it only shrinks)", () => {
    const stale = listed.filter((k) => contractKeys.includes(k) || !opKeys.has(k));
    expect(stale, "delete these lines from openapi/internal-routes.txt").toEqual([]);
  });
});

describe("contracts", () => {
  it("each describes a real operation", () => {
    expect(contractKeys.filter((k) => !opKeys.has(k)), "no route.ts exports this method at this path").toEqual([]);
  });

  it("operationIds are unique, and each contract's export name is its operationId", () => {
    const ids = contracts.map((c) => c.operationId);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    for (const mod of contractModules) {
      for (const [name, v] of Object.entries(mod)) {
        if (isRouteContract(v)) expect(v.operationId).toBe(name);
      }
    }
  });

  it("contracts.generated.ts imports every route.contract.ts", () => {
    const generated = readFileSync("src/lib/openapi/contracts.generated.ts", "utf8");
    const imported = [...generated.matchAll(/from "@\/(.+)";/g)].map((m) => `src/${m[1]}.ts`);
    expect(imported, "run `npm run openapi`").toEqual(contractFiles());
  });

  it("contract files stay pure: zod, lib/openapi and the scope list only", () => {
    // The spec build runs them in plain node, and the docs page imports them.
    // A prisma or next import here would drag a server into both.
    const allowed = /^(zod|@\/lib\/openapi\/(contract|problem-codes|version|schemas\/[\w.-]+)|@\/lib\/auth\/api-key-scopes|\.\.?\/.*route\.contract)$/;
    const bad = contractFiles().flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/from\s+"([^"]+)"/g)]
        .map((m) => m[1]).filter((spec) => !allowed.test(spec)).map((spec) => `${f}: ${spec}`),
    );
    expect(bad).toEqual([]);
  });

  it("a stable or beta operation's handler validates with parseRequest, checks scopes via orgContext and answers with respond", () => {
    const missing: string[] = [];
    for (const c of contracts.filter((x) => x.stability !== "internal")) {
      const key = operationKey(c.method, c.path);
      const file = operations.find((o) => o.key === key)?.file;
      if (!file) continue; // reported above
      const src = readFileSync(file, "utf8");
      if (!new RegExp(`parseRequest\\(\\s*${c.operationId}\\b`).test(src)) missing.push(`${key}: parseRequest(${c.operationId}, …)`);
      if (!new RegExp(`respond\\(\\s*${c.operationId}\\b`).test(src)) missing.push(`${key}: respond(${c.operationId}, …)`);
      // The scope gate lives in orgContext, so the handler must hand it the contract.
      if (!new RegExp(`orgContext\\((?:[^()]|\\([^()]*\\))*\\b${c.operationId}\\b`).test(src)) missing.push(`${key}: orgContext(…, ${c.operationId})`);
    }
    expect(missing).toEqual([]);
  });

  it("a stable or beta operation names at least one scope (empty refuses every key)", () => {
    const empty = contracts.filter((c) => c.stability !== "internal" && c.scopes.length === 0).map((c) => c.operationId);
    expect(empty).toEqual([]);
  });
});

describe("openapi/cosmos-v1.json", () => {
  it("is what the contracts build (run `npm run openapi` and commit it)", () => {
    const committed = JSON.parse(readFileSync("openapi/cosmos-v1.json", "utf8"));
    expect(JSON.parse(JSON.stringify(buildDocument(contracts, "public")))).toEqual(committed);
  });
});
