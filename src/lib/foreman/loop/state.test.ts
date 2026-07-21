// @vitest-environment node
import { describe, it, expect } from "vitest";
import { initialState, serialize, deserialize, hashString, SCHEMA_VERSION } from "./state";
import type { TicketBrief } from "@/lib/foreman/prompt";

const brief: TicketBrief = { key: "COSMOS-1", title: "t", description: "d", classification: "FEATURE", acceptanceCriteria: ["a"] };

describe("initialState", () => {
  it("starts queued at iteration 0 with no live handles", () => {
    const s = initialState("00000000-0000-0000-0000-000000000001", "org1", brief, 1000);
    expect(s.phase).toBe("queued");
    expect(s.iteration).toBe(0);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.sessionRef).toBeNull();
    expect(s.startedAtMs).toBe(1000);
  });
});

describe("serialize/deserialize", () => {
  it("round-trips through JSON with no loss", () => {
    const s = initialState("id", "org1", brief, 1000);
    const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
    expect(back).toEqual(s);
  });
  it("stamps an older-version blob up to the current SCHEMA_VERSION", () => {
    const s = initialState("id", "org1", brief, 1000);
    const old = { ...s, schemaVersion: 0 };
    expect(deserialize(old).schemaVersion).toBe(SCHEMA_VERSION);
  });
  it("throws on a non-object blob", () => {
    expect(() => deserialize(null)).toThrow();
    expect(() => deserialize("nope")).toThrow();
  });
  it("throws on a malformed blob missing loopId/phase", () => {
    expect(() => deserialize({ orgId: "o" })).toThrow();
  });
});

describe("hashString", () => {
  it("is deterministic and differs for different inputs", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });
});
