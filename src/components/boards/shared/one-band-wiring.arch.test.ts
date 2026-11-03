// A board that hands its actions to one filter surface hands them to BOTH.
//
// Every board renders two: `<BoardQueryBar>` when the org has the query
// language on, `<FilterBar>` when it does not. They are an either/or at
// runtime, so wiring only one is invisible in development and in any test of
// the other path -- the board simply loses its buttons for half the
// organisations using it.
//
// This is the mechanical half of ffe324aa (one chrome band instead of two with
// character-for-character identical classes). The behavioural half is
// `kanban-board.one-band.test.tsx`, which renders a board and asserts the
// search box and the create control share ONE bordered ancestor; that one
// needs a full render harness per board, which is why this rule exists to cover
// the rest uniformly.
//
// Scoped to boards that declare `boardActions`, so it holds each board from the
// moment it converts rather than demanding every board convert at once.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { codeWithoutComments } from "../../../lib/arch/code-without-comments";

const BOARDS = "src/components/boards";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(full);
  }
  return out;
}

// Shared helper: six copies of this had diverged, and every one stripped
// block comments BEFORE line comments, so a line comment containing a
// block-opener sequence was read as a real block opener and blanked the
// file to the next close. In board-tabs.tsx that hid 371 lines, including
// the element one of these rules asserts on. See code-without-comments.
const code = codeWithoutComments;

/** Each opening tag of `name`, with everything up to the end of its props. */
function openings(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}(?=[\\s>])`, "g");
  for (const m of src.matchAll(re)) {
    // Props run to the first `>` that is not inside a brace expression.
    let depth = 0;
    let i = m.index! + m[0].length;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    out.push(src.slice(m.index!, i + 1));
  }
  return out;
}

const views = walk(BOARDS);
const converted = views.filter((f) => /\bconst boardActions\b/.test(code(readFileSync(f, "utf8"))));

describe("one-band wiring", () => {
  it("found board views to check", () => {
    expect(views.length).toBeGreaterThan(10);
  });

  it("found converted boards", () => {
    // Without this the rule below is vacuous.
    expect(converted.length).toBeGreaterThan(0);
  });

  it("every filter surface on a converted board receives `actions`", () => {
    const offenders: string[] = [];
    for (const f of converted) {
      const src = code(readFileSync(f, "utf8"));
      for (const surface of ["FilterBar", "BoardQueryBar"]) {
        for (const tag of openings(src, surface)) {
          if (!/\bactions=/.test(tag)) {
            offenders.push(`${f} → <${surface}> without \`actions\``);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a converted board renders no BoardToolbar beside a filter surface", () => {
    // The band it replaced. A converted board may still render `BoardToolbar`
    // on a path that has NO filter surface (Kanban's pre-data path), so the
    // rule is about the count, not the mere presence: more `BoardToolbar`
    // bands than filter-surface-free returns means one came back.
    const offenders: string[] = [];
    for (const f of converted) {
      const src = code(readFileSync(f, "utf8"));
      const bands = openings(src, "BoardToolbar").length;
      const surfaces =
        openings(src, "FilterBar").length + openings(src, "BoardQueryBar").length;
      // Each board renders exactly one filter surface per branch of one
      // either/or, so `surfaces` counts its filtered returns. A band for each
      // of those would mean nothing was merged.
      if (bands >= surfaces) {
        offenders.push(`${f} → ${bands} BoardToolbar band(s) vs ${surfaces} filter surface(s)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
