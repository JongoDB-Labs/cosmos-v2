// @vitest-environment node
//
// The project's landing page must not title itself with the project's name.
//
// The layout renders `<h1>{project.name}</h1>` in the bar above every page in
// the project. When the landing page ALSO passed `title={project.name}` to
// PageShell, the same words appeared twice about 110px apart — and because that
// branch only renders for a project with no boards yet, it landed on the
// emptiest screen in the app, where it read as a render bug rather than as a
// project waiting for its first board.
//
// The obvious-looking fix is to stop the bar being a heading. It is wrong, and
// expensively so: the BOARD page renders no title of its own, so that bar is
// the only heading on the page a project actually lands on. Demoting it left
// that page with no heading at all, which journey-create-project.spec.ts caught
// by asking for a heading named after the project after creating one. Hence a
// narrow rule about the duplicate, not a broad one about layouts.
//
// Still outstanding, deliberately: pages that DO set a PageShell title carry
// two h1s, because PageShell hardcodes h1 and cannot yet be told to render an
// h2 under the project's. That wants a change to a component the whole app
// uses, and its own pass.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LANDING = "src/app/(dashboard)/[orgSlug]/projects/[projectKey]/page.tsx";
const LAYOUT = "src/app/(dashboard)/[orgSlug]/projects/[projectKey]/layout.tsx";

function code(rel: string): string {
  // Strip comments: the explanation above each of these names the exact
  // expression it exists to forbid.
  return readFileSync(join(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the project landing page", () => {
  it("does not repeat the name the layout bar already shows", () => {
    expect(code(LANDING)).not.toContain("title={project.name}");
  });

  it("is checked against a layout that really does show it", () => {
    // Guard the guard, and pin the reason the rule above is narrow: if the bar
    // ever stops naming the project, this rule is measuring nothing and the
    // board page has lost its only heading.
    expect(code(LAYOUT)).toContain("<h1");
    expect(code(LAYOUT)).toContain("{project.name}");
  });
});
