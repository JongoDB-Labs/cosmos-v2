import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The SSP is a LIVING DOCUMENT whose machine-readable half is
 * `compliance/ssp/control-coverage.csv`. `check:control-coverage` validates the
 * CSV in isolation — nothing ever checked that the prose agreed with it, so the
 * narrative kept calling controls planned/deferred long after the matrix
 * recorded them as shipped, and the document's own cross-references, family
 * counts and POA&M numbering drifted out of step with its body.
 *
 * These assertions are about internal consistency only. The prose may say
 * anything the matrix says; it may not contradict it, and it may not point at
 * headings or counts that do not exist.
 */

const ROOT = process.cwd();
const SSP_PATH = join(ROOT, "compliance", "ssp", "SSP.md");
const CSV_PATH = join(ROOT, "compliance", "ssp", "control-coverage.csv");

const ssp = readFileSync(SSP_PATH, "utf8");
const sspLines = ssp.split("\n");

/**
 * Only `notes` (the last column) carries commas, so the five leading columns
 * split cleanly — the same assumption `scripts/check-control-coverage.mjs`
 * makes when it reads controlId/family/status positionally.
 */
const csvRows = readFileSync(CSV_PATH, "utf8")
  .split("\n")
  .slice(1)
  .filter((l) => l.trim() !== "")
  .map((line) => {
    const cells = line.split(",");
    return {
      controlId: cells[0].trim(),
      family: cells[1].trim(),
      status: cells[4].trim(),
      notes: cells.slice(6).join(",").trim(),
    };
  });

const rowFor = (controlId: string) => csvRows.find((r) => r.controlId === controlId);
const statusOf = (controlId: string) => rowFor(controlId)?.status;

/** The body of a `##`/`###` section, up to the next heading of either level. */
function section(heading: string): string {
  const start = ssp.indexOf(heading);
  expect(start, `heading not found: ${heading}`).toBeGreaterThan(-1);
  const rest = ssp.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The "COSMOS v2 Responsibility" cell of a §5 matrix row. */
function responsibilityCell(label: string): string {
  const row = sspLines.find((l) => l.startsWith(`| **${label}**`));
  expect(row, `no §5 matrix row labelled ${label}`).toBeDefined();
  return row!.split("|")[3].trim();
}

describe("SSP header agrees with its own revision history", () => {
  const revisions = sspLines.filter((l) => /^\| \d{4}-\d{2}-\d{2} \|/.test(l));

  it("has a revision history to compare against", () => {
    expect(revisions.length).toBeGreaterThan(0);
  });

  it("document date and system version match the newest revision row", () => {
    const newest = revisions[revisions.length - 1].split("|").map((c) => c.trim());
    const [, date, version] = newest;

    expect(/\*\*Document date:\*\* (\S+)/.exec(ssp)?.[1]).toBe(date);
    expect(/\*\*System version:\*\*[^\n]*?v([0-9][^)\s]*)\)/.exec(ssp)?.[1]).toBe(version);
  });
});

describe("SSP cross-references resolve", () => {
  const headings = new Set(
    [...ssp.matchAll(/^#{2,3} (\d+(?:\.\d+)?)/gm)].map((m) => m[1]),
  );

  it("numbers the per-family subsections under §4, not §3", () => {
    // They are subsections of "## 4. Per-Family Implementation Statements"; when
    // they were numbered 3.x they collided with "## 3. Data Flow Summary" and
    // every §4.x reference resolved to nothing.
    expect(sspLines.filter((l) => /^### 3\./.test(l))).toEqual([]);
    for (const n of [1, 8, 12, 14]) expect(headings).toContain(`4.${n}`);
  });

  it("every §X.Y reference points at a heading that exists", () => {
    const refs = [...ssp.matchAll(/§(\d+\.\d+)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !headings.has(r))).toEqual([]);
  });
});

describe("SSP prose does not contradict the control matrix", () => {
  it("states the CSV status for 3.7.5 and excludes it from the MA policy sweep", () => {
    const ma = section("### 4.7 Maintenance (MA)");
    expect(ma).toContain(`\`${statusOf("3.7.5")}\``);
    expect(ma).not.toMatch(/3\.7\.1[–-]3\.7\.6/);
  });

  it("counts only the MA practices the CSV marks policy-required", () => {
    const maPolicy = csvRows.filter(
      (r) => r.family === "MA" && r.status === "policy-required-not-yet-authored",
    );
    expect(maPolicy.length).toBeGreaterThan(0);
    expect(section("### What this SSP does NOT cover (policy-pending)")).toContain(
      `MA (${maPolicy.length})`,
    );
  });

  it("does not open §4.8 by calling the shipped envelope encryption planned", () => {
    expect(statusOf("3.13.16")).toBe("implemented");
    const opening = section("### 4.8 Media Protection (MP)").trim().split("\n")[0];
    expect(opening).toMatch(/planned/);
    expect(opening).not.toMatch(/envelope encryption/i);
  });

  it("never describes the audit hash-chain / WORM anchor as deferred", () => {
    expect(statusOf("3.3.8")).toBe("implemented");
    const offenders = sspLines.filter(
      (l) =>
        /hash.chain|WORM/i.test(l) &&
        /deferred|design complete|not yet implemented/i.test(l),
    );
    expect(offenders).toEqual([]);
  });

  it("lists no open POA&M item against a control the CSV marks implemented", () => {
    const ca = section("### 4.12 Security Assessment (CA)");
    const items = [...ca.matchAll(/^\d+\. \*\*.*$/gm)].map((m) => m[0]);
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      const cited = [...item.matchAll(/\b3\.\d+\.\d+\b/g)].map((m) => m[0]);
      for (const id of cited) {
        expect(statusOf(id), `POA&M item cites ${id}: ${item.slice(0, 60)}`).not.toBe(
          "implemented",
        );
      }
    }
  });

  it("numbers the POA&M items contiguously and matches the §6 open count", () => {
    const ca = section("### 4.12 Security Assessment (CA)");
    const numbers = [...ca.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));

    const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven"];
    expect(section("### Current POA&M Items")).toContain(
      `${WORDS[numbers.length]} items are open`,
    );
  });

  it("does not call a shipped responsibility-matrix capability planned", () => {
    for (const [label, controlId] of [
      ["Storage encryption at rest", "3.13.16"],
      ["Data backups", "3.8.9"],
      ["Identity infrastructure", "3.5.3"],
    ]) {
      expect(["implemented", "partial"]).toContain(statusOf(controlId));
      expect(responsibilityCell(label), `${label} row`).toMatch(/implemented/);
    }
  });
});

describe("control-coverage.csv stays a matrix, not a second narrative", () => {
  it("keeps the 3.8.9 note to the control statement plus a pointer", () => {
    const note = rowFor("3.8.9")?.notes ?? "";
    expect(note).toMatch(/pgBackRest/);
    expect(note).toMatch(/restore-drill\.sh/);
    expect(note).toMatch(/SSP\.md §4\.8/);
    expect(note.length).toBeLessThan(1200);

    // The cutover narrative lives in the SSP and the runbook — one copy, not two.
    for (const token of ["soak-sync", "orchestrate.mjs", "proxy-control"]) {
      expect(ssp, `${token} should still be described in the SSP`).toContain(token);
      expect(note, `${token} duplicated into the matrix row`).not.toContain(token);
    }
  });
});
