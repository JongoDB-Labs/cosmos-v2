import { describe, it, expect } from "vitest";
import { entityUrl } from "@/lib/mentions/urls";

/**
 * "Copy link" on an issue row must copy a link to THAT ISSUE.
 *
 * It copied the board href — `/{org}/projects/{KEY}` — and toasted "Board link
 * copied", so pasting it dropped the recipient on the project with no
 * indication which ticket was meant. On a per-row action that is the opposite
 * of what the label promises.
 *
 * The fix routes through `entityUrl`, the builder the mention chips, home
 * widgets and dependency map already share, so there is one definition of an
 * issue deep link. This pins the CONTRACT that matters: the copied URL carries
 * the item id in the `?item=` form the issues view opens a detail sheet for
 * (verified against production), and is not merely the project page.
 */
describe("issue deep link (what Copy link copies)", () => {
  const orgSlug = "acme";
  const id = "435bce4f-2204-40df-9535-a8b4dc31d677";

  it("addresses the item, not the board or project", () => {
    const href = entityUrl("workItem", { orgSlug, id });
    expect(href).toBe(`/${orgSlug}/issues?item=${id}`);
  });

  it("is not the project page the old implementation copied", () => {
    const href = entityUrl("workItem", { orgSlug, id })!;
    // The regression shape: `/acme/projects/FSC` with no item reference.
    expect(href).not.toMatch(/\/projects\/[^/]+$/);
    expect(href).toContain(id);
  });

  it("carries the item id in the param the issues view reads", () => {
    // issues-view.tsx does `searchParams.get("item")`. If this param is ever
    // renamed, every deep link in the product breaks together — which is the
    // point of having one builder.
    const href = entityUrl("workItem", { orgSlug, id })!;
    const qs = new URLSearchParams(href.split("?")[1]);
    expect(qs.get("item")).toBe(id);
  });

  it("does not need a project key, so it works from the org-wide issues list", () => {
    // The row's project key is irrelevant to addressing the item; requiring it
    // would break Copy link on any row whose project wasn't loaded.
    expect(entityUrl("workItem", { orgSlug, id, projectKey: null })).toBe(
      `/${orgSlug}/issues?item=${id}`,
    );
  });
});

/**
 * The above pins the URL SHAPE. It does not pin that "Copy link" USES it — and
 * mutation-testing proved that gap: reverting the handler to `boardHref` left
 * every test above green. That is precisely the defect class of #506, where a
 * correct helper shipped for three releases while the call sites ignored it.
 *
 * So this asserts the CALL SITE in source: the Copy link handler must build its
 * URL from `entityUrl(...)` and must not copy the board href.
 */
import { readFileSync } from "node:fs";

describe("Copy link call site", () => {
  const SRC = "src/components/work-items/issues-view.tsx";
  const src = readFileSync(SRC, "utf8");

  /** The `{ label: "Copy link", … }` menu entry, up to the end of its handler. */
  function copyLinkHandler(): string {
    const i = src.indexOf('label: "Copy link"');
    expect(i).toBeGreaterThan(-1); // not vacuous: the entry must exist
    return src.slice(i, i + 900);
  }

  it("builds the copied URL with entityUrl", () => {
    expect(copyLinkHandler()).toMatch(/entityUrl\(\s*"workItem"/);
  });

  it("does not copy the board href", () => {
    const handler = copyLinkHandler();
    expect(handler).not.toMatch(/writeText\(`\$\{window\.location\.origin\}\$\{boardHref\}`\)/);
    expect(handler).not.toMatch(/const href = boardHref/);
  });

  it("does not tell the user it copied a board link", () => {
    expect(copyLinkHandler()).not.toContain("Board link copied");
  });
});

/**
 * The sibling menu entry, which sits directly above Copy link and used to be
 * confused with it.
 *
 * It navigates to the PROJECT, which redirects to whichever board you land on
 * by default. It cannot open "the board this row is on", because a work item
 * carries a `columnKey` and not a board — the same item appears on every board
 * of the project with a matching column. So the label has to name the project,
 * or it promises something the data model cannot deliver.
 */
describe("the project-board menu entry names what it opens", () => {
  const SRC = "src/components/work-items/issues-view.tsx";
  const src = readFileSync(SRC, "utf8");

  it("does not claim to open the board holding this item", () => {
    // "Open in board" reads as "the board this issue is on", which does not
    // exist. Guarded as a substring so a re-word back to it fails here.
    expect(src).not.toContain('label: "Open in board"');
  });

  it("offers an entry that names the project board", () => {
    expect(src).toContain('label: "Open project board"');
  });

  it("navigates to the project, letting the default-board redirect choose", () => {
    const i = src.indexOf('label: "Open project board"');
    expect(i).toBeGreaterThan(-1); // not vacuous: the entry must exist
    const entry = src.slice(i, i + 220);
    expect(entry).toContain("projectBoardHref");
    // Not a hardcoded /boards/<id>: the redirect honours the user's preference.
    expect(entry).not.toMatch(/\/boards\//);
  });
});
