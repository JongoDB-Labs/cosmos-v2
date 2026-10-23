// Feedback comments are read in ONE place (comments.server.ts), so who may see
// an internal note is decided once. A second query site is how a surface ends
// up showing staff notes to members; this keeps that from happening silently.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "../..");
const ALLOWED = new Set([
  "lib/feedback/comments.server.ts",
  // Deleting a request takes its discussion with it (ids only, no content).
  "app/api/v1/orgs/[orgId]/feedback/[feedbackId]/route.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("feedback comments have one reader", () => {
  it("queries comments by the feedback subject only in comments.server.ts", () => {
    const offenders = walk(ROOT)
      .filter((f) => /subjectType:\s*(FEEDBACK_SUBJECT|["']feedback["'])/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f))
      .filter((f) => !ALLOWED.has(f));
    expect(offenders).toEqual([]);
  });
});
