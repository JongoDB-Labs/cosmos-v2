import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDatabaseUrl, DEFAULT_TEST_DATABASE_URL } from "./test-db";

// This suite runs under Foreman's own checks with DATABASE_URL pointed at the e2e
// bridge, so it must fully control both env vars rather than inherit the ambient
// ones — otherwise the default-parameter path (liveUrl = process.env.DATABASE_URL)
// reads a value the test didn't set.
const ORIG_TEST = process.env.FOREMAN_TEST_DATABASE_URL;
const ORIG_LIVE = process.env.DATABASE_URL;
const PROD = "postgresql://cosmos:cosmos@127.0.0.1:55432/cosmos";

beforeEach(() => {
  delete process.env.FOREMAN_TEST_DATABASE_URL;
  delete process.env.DATABASE_URL;
});
afterAll(() => {
  if (ORIG_TEST === undefined) delete process.env.FOREMAN_TEST_DATABASE_URL;
  else process.env.FOREMAN_TEST_DATABASE_URL = ORIG_TEST;
  if (ORIG_LIVE === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIG_LIVE;
});

describe("testDatabaseUrl", () => {
  it("defaults to the local e2e bridge", () => {
    expect(testDatabaseUrl(PROD)).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it("honors the FOREMAN_TEST_DATABASE_URL override", () => {
    process.env.FOREMAN_TEST_DATABASE_URL = "postgresql://u:p@127.0.0.1:5599/testdb";
    expect(testDatabaseUrl(PROD)).toBe("postgresql://u:p@127.0.0.1:5599/testdb");
  });

  it("refuses when the test URL equals the passed live URL (never run tests on prod)", () => {
    process.env.FOREMAN_TEST_DATABASE_URL = PROD;
    expect(() => testDatabaseUrl(PROD)).toThrow(/refusing to run tests against prod/);
  });

  it("reads the live URL from process.env.DATABASE_URL when no arg is passed", () => {
    // The daemon's live DATABASE_URL is the guard reference; if a misconfig made the
    // test URL equal it, the no-arg call (default param) must still trip the guard.
    process.env.DATABASE_URL = DEFAULT_TEST_DATABASE_URL;
    expect(() => testDatabaseUrl()).toThrow(/refusing to run tests against prod/);
  });

  it("does not throw when there is no live URL to collide with", () => {
    // DATABASE_URL deleted in beforeEach → default param resolves to undefined.
    expect(testDatabaseUrl()).toBe(DEFAULT_TEST_DATABASE_URL);
  });
});
