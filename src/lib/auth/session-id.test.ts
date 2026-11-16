import { describe, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sessionRowId } from "./session-id";
// The dev-session script carries its own copy (a plain node script can't
// import TypeScript); it must store the same row id the app looks up.
import { sessionRowId as devScriptCopy } from "../../../scripts/create-dev-session.mjs";

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

describe("the dev-session script's copy of sessionRowId", () => {
  // Digests from an independent tool (`printf '%s' … | shasum -a 256`).
  const vectors: [string, string][] = [
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["a\\b", "c62016d0f8ee333350283fd879b50b692932e932794e5d686f7d37d67484e199"],
    ["jeton-été", "738387ee5a2ad5acc5d46359c2b64661d83b8c76de621bc6ed4352d13d6142fd"],
    ["セッション", "fbb0bd6e70e2c8466a99176d78ce1a70b015edc5cd9eb80ef89832634adb59cc"],
    ["0123456789abcdef".repeat(4), "a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e"],
  ];

  it.each(vectors)("gives the app's digest for %j", (token, digest) => {
    expect(sessionRowId(token)).toBe(digest);
    expect(devScriptCopy(token)).toBe(digest);
  });

  it("agrees with the app on the shapes of token each one mints", () => {
    // The app mints 64 hex characters; the script mints a UUID.
    for (const token of [randomBytes(32).toString("hex"), randomUUID()]) {
      expect(devScriptCopy(token)).toBe(sessionRowId(token));
    }
  });
});
