// src/lib/classification/__tests__/effective-invalid-id.test.ts
// @vitest-environment node
//
// COSMOS-176: `effectiveCeiling`'s projectId reaches the agent loop straight from
// MODEL input, and `DataClassification.projectId` is a `@db.Uuid` column. An id
// the model invented rather than resolved therefore raised Prisma P2007 here —
// after the tool had returned, where nothing caught it.
//
// Runs against the REAL database (no prisma mock) so the uuid rejection under
// test is Postgres's own rule rather than a stub's.
import { describe, it, expect } from "vitest";
import { effectiveCeiling } from "../effective";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const HALLUCINATED_ID = "f9s8d7f9-demo-proj-id";
const UNKNOWN_UUID = "33333333-3333-3333-3333-333333333333";

describe("effectiveCeiling — a projectId that is not a uuid", () => {
  it("resolves a ceiling instead of throwing the database's uuid error", async () => {
    await expect(effectiveCeiling(ORG_ID, HALLUCINATED_ID)).resolves.toBe("UNCLASSIFIED");
  });

  it("answers exactly as it does for a well-formed id no project has", async () => {
    // The equivalence is the whole argument for dropping the predicate: a uuid
    // column cannot hold an id of that shape, so the per-project row could never
    // have matched, and the org row is the answer either way. Nothing is
    // down-classified by skipping a predicate guaranteed to miss.
    const forInvented = await effectiveCeiling(ORG_ID, HALLUCINATED_ID);
    const forUnknown = await effectiveCeiling(ORG_ID, UNKNOWN_UUID);
    expect(forInvented).toBe(forUnknown);
  });
});
