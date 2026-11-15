import { describe, it, expect } from "vitest";
import { sessionRowId } from "./session-id";

describe("sessionRowId", () => {
  it("is the SHA-256 of the cookie's value, as lowercase hex", () => {
    // The published SHA-256 test vector for "abc" (FIPS 180-2).
    expect(sessionRowId("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is never the value it was given, and the same value always gives the same id", () => {
    const token = "a".repeat(64);
    expect(sessionRowId(token)).not.toBe(token);
    expect(sessionRowId(token)).toBe(sessionRowId(token));
    expect(sessionRowId(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the text's UTF-8 bytes, as the migration's convert_to does", () => {
    // A backslash is where a bytea cast and the UTF-8 bytes disagree.
    expect(sessionRowId("a\\b")).toBe("c62016d0f8ee333350283fd879b50b692932e932794e5d686f7d37d67484e199");
  });
});
