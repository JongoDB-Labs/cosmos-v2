import { describe, it, expect } from "vitest";
import { FetchError } from "@/lib/query/json-fetcher";
import { FRESH_READ, classifyBoardLoad, recordFetch } from "./board-load-state";

const http = (status: number) => new FetchError(status, null, `HTTP ${status}`);

describe("classifyBoardLoad", () => {
  it("no data + error → fatal", () => {
    const v = classifyBoardLoad([{ error: http(500), hasData: false }]);
    expect(v).toMatchObject({ fatal: true, refreshFailed: false });
  });

  it("data + 500 → refresh failed, not fatal", () => {
    const v = classifyBoardLoad([{ error: http(500), hasData: true, notFoundIsAccess: true }]);
    expect(v).toMatchObject({ fatal: false, refreshFailed: true });
  });

  it.each([401, 403])("%i is fatal even with data", (status) => {
    const v = classifyBoardLoad([{ error: http(status), hasData: true }]);
    expect(v.fatal).toBe(true);
  });

  it("404 on the board detail is fatal (hidden or gone)", () => {
    const v = classifyBoardLoad([
      { error: http(404), hasData: true, notFoundIsAccess: true },
      { error: null, hasData: true, notFoundIsAccess: true },
    ]);
    expect(v.fatal).toBe(true);
  });

  it("404 on the items read is fatal", () => {
    const v = classifyBoardLoad([
      { error: null, hasData: true, notFoundIsAccess: true },
      { error: http(404), hasData: true, notFoundIsAccess: true },
    ]);
    expect(v.fatal).toBe(true);
  });

  it("404 on a read whose 404 is not about access keeps the data", () => {
    const v = classifyBoardLoad([{ error: http(404), hasData: true }]);
    expect(v).toMatchObject({ fatal: false, refreshFailed: true });
  });

  it("mixed 500 + 403 → fatal, and the 403 is the reported error", () => {
    const forbidden = http(403);
    const v = classifyBoardLoad([
      { error: http(500), hasData: true },
      { error: forbidden, hasData: true },
    ]);
    expect(v.fatal).toBe(true);
    expect(v.fatalError).toBe(forbidden);
  });

  it("a cleared error with lastFetchFailed still counts as refresh failed", () => {
    const v = classifyBoardLoad([{ error: null, hasData: true, lastFetchFailed: true }]);
    expect(v).toMatchObject({ fatal: false, refreshFailed: true });
  });

  it("all good → neither", () => {
    const v = classifyBoardLoad([{ error: null, hasData: true }]);
    expect(v).toMatchObject({ fatal: false, refreshFailed: false });
  });
});

describe("recordFetch (access latch)", () => {
  it("a transient 500 after an access error stays fatal until a success", () => {
    let m = recordFetch(FRESH_READ, { ok: false, error: http(403) });
    m = recordFetch(m, { ok: false, error: http(500) });
    expect(m.accessLatched).toBe(true);
    expect(classifyBoardLoad([{ error: http(500), hasData: true, ...m }]).fatal).toBe(true);

    m = recordFetch(m, { ok: true });
    expect(m).toEqual(FRESH_READ);
    expect(classifyBoardLoad([{ error: null, hasData: true, ...m }]).fatal).toBe(false);
  });

  it("404 latches only where a 404 means access", () => {
    expect(recordFetch(FRESH_READ, { ok: false, error: http(404) }).accessLatched).toBe(false);
    expect(
      recordFetch(FRESH_READ, { ok: false, error: http(404), notFoundIsAccess: true }).accessLatched,
    ).toBe(true);
  });
});
