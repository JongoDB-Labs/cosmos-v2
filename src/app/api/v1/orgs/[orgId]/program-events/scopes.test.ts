// @vitest-environment node
//
// The program-calendar contracts declare `scopes: []`, which means "no API key
// may call this". That promise is only kept if the route goes through
// `orgContext` — `assertScopes` runs nowhere else, and `getAuthContext` alone
// authenticates a key and waves it straight through.
//
// The first version of these routes called `getAuthContext` directly, so the
// declared scopes were never enforced and the contract's own comment claiming
// it "refuses every bearer token" was false. Found by review. These specs pin
// both halves: the contracts still declare no scopes, and the rule that reads
// them refuses a key.
import { describe, it, expect } from "vitest";
import { assertScopes } from "@/lib/openapi/org-context";
import type { AuthContext } from "@/lib/rbac/check";
import { listProgramEvents, createProgramEvent } from "./route.contract";
import {
  getProgramEvent,
  updateProgramEvent,
  deleteProgramEvent,
} from "./[eventId]/route.contract";
import {
  listEventCategories,
  createEventCategory,
} from "../event-categories/route.contract";

const CONTRACTS = [
  ["listProgramEvents", listProgramEvents],
  ["createProgramEvent", createProgramEvent],
  ["getProgramEvent", getProgramEvent],
  ["updateProgramEvent", updateProgramEvent],
  ["deleteProgramEvent", deleteProgramEvent],
  ["listEventCategories", listEventCategories],
  ["createEventCategory", createEventCategory],
] as const;

const apiKey = (scopes: string[]) =>
  ({ isApiKey: true, scopes, orgId: "o", userId: "u" }) as unknown as AuthContext;
const session = () => ({ isApiKey: false, orgId: "o", userId: "u" }) as unknown as AuthContext;

describe("no API key reaches the program calendar", () => {
  it.each(CONTRACTS)("%s declares no scopes and is internal", (_name, contract) => {
    expect(contract.scopes).toEqual([]);
    expect(contract.stability).toBe("internal");
  });

  it.each(CONTRACTS)("%s refuses a key even with every scope", (_name, contract) => {
    const everything = ["read", "items:write", "items:delete", "planning:write", "documents:write"];
    expect(() => assertScopes(apiKey(everything), contract)).toThrow();
  });

  it.each(CONTRACTS)("%s still admits a browser session", (_name, contract) => {
    // The positive control. A rule that threw for everyone would satisfy the
    // assertions above while breaking the product.
    expect(() => assertScopes(session(), contract)).not.toThrow();
  });
});
