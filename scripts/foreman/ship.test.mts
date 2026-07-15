// Unit tests for the idempotent PR upsert (ensurePr) — the fix for COSMOS-124:
// on a REBUILD the branch (auto/<KEY>) is reused, so a re-park could hit a branch
// that still has an OPEN PR. A bare `gh pr create` throws ("a pull request for
// branch … already exists") and left the card stuck in-progress. ensurePr must
// UPDATE the existing PR instead, and only CREATE when none is open.
//
// No live gh/GitHub: a fake PrRunner records the `gh` invocations and returns
// canned stdout, so the create-vs-update decision is exercised deterministically.
import { describe, it, expect } from "vitest";
import { ensurePr, findOpenPr } from "./ship.mjs";

type Call = { cmd: string; args: string[] };

/** Build a fake runner over a `gh pr list` result. Records every call so the
 *  test can assert which git-hub verb ran (create vs edit/ready). */
function fakeRunner(listJson: string, createUrl = "https://github.com/o/r/pull/999") {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[]): Promise<string> => {
    calls.push({ cmd, args });
    if (args[0] === "pr" && args[1] === "list") return listJson;
    if (args[0] === "pr" && args[1] === "create") return `${createUrl}\n`;
    // edit / ready produce no url we depend on
    return "";
  };
  return { run, calls };
}

const ran = (calls: Call[], verb: string) =>
  calls.some((c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === verb);

describe("ensurePr — existing-open-PR path (rebuild re-park)", () => {
  it("UPDATES the open PR (edit + ensure draft) and returns its url — never creates", async () => {
    const existingUrl = "https://github.com/o/r/pull/340";
    const { run, calls } = fakeRunner(`[{"number":340,"url":"${existingUrl}"}]`);

    const url = await ensurePr("auto/COSMOS-120", "auto: COSMOS-120 (review — x)", "body", true, run);

    expect(url).toBe(existingUrl); // parked card records the EXISTING PR url → Approve merges it
    expect(ran(calls, "create")).toBe(false); // the create that used to throw never runs
    // edited title/body on the existing PR number, then converted back to draft
    const edit = calls.find((c) => c.args[1] === "edit");
    expect(edit?.args).toEqual(["pr", "edit", "340", "--title", "auto: COSMOS-120 (review — x)", "--body", "body"]);
    const ready = calls.find((c) => c.args[1] === "ready");
    expect(ready?.args).toEqual(["pr", "ready", "340", "--undo"]);
  });

  it("skips the draft conversion when a non-draft PR is requested", async () => {
    const { run, calls } = fakeRunner(`[{"number":7,"url":"https://github.com/o/r/pull/7"}]`);
    await ensurePr("auto/COSMOS-1", "t", "b", false, run);
    expect(ran(calls, "edit")).toBe(true);
    expect(ran(calls, "ready")).toBe(false);
    expect(ran(calls, "create")).toBe(false);
  });
});

describe("ensurePr — no-PR path (first park)", () => {
  it("CREATES a draft PR and returns the new url", async () => {
    const { run, calls } = fakeRunner("[]", "https://github.com/o/r/pull/1000");

    const url = await ensurePr("auto/COSMOS-200", "auto: COSMOS-200 (review — y)", "body", true, run);

    expect(url).toBe("https://github.com/o/r/pull/1000");
    const create = calls.find((c) => c.args[1] === "create");
    expect(create).toBeTruthy();
    expect(create?.args).toContain("--draft"); // draft requested → --draft passed
    expect(ran(calls, "edit")).toBe(false);
  });
});

describe("findOpenPr", () => {
  it("parses the first open PR", async () => {
    const { run } = fakeRunner(`[{"number":42,"url":"https://github.com/o/r/pull/42"}]`);
    expect(await findOpenPr("auto/COSMOS-9", run)).toEqual({ number: 42, url: "https://github.com/o/r/pull/42" });
  });

  it("returns null when no PR is open", async () => {
    const { run } = fakeRunner("[]");
    expect(await findOpenPr("auto/COSMOS-9", run)).toBeNull();
  });

  it("returns null (best-effort) when gh errors", async () => {
    const run = async () => {
      throw new Error("gh: not found");
    };
    expect(await findOpenPr("auto/COSMOS-9", run)).toBeNull();
  });
});
