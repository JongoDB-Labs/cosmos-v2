// The Work Items table is wide, and it is the whole page. In PageShell's default
// 7xl column (1280px) it scrolled sideways while the rest of a wide window sat
// empty beside it. These pin the page to the full-width shell, and its loading
// skeleton to the same box, so the page does not jump wider when it arrives.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Suspense, type ReactElement } from "react";
import { render, within, cleanup } from "@testing-library/react";

const { getAuthContext, getOrgById, canViewPage } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  getOrgById: vi.fn(),
  canViewPage: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/cache/queries", () => ({ getOrgById }));
vi.mock("@/lib/nav/page-access", () => ({ canViewPage }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("redirect");
  }),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));
// The view is a large client component with tests of its own. This file is
// about the box it sits in.
vi.mock("@/components/work-items/work-items-view", () => ({
  WorkItemsView: () => <div data-testid="work-items-view" />,
}));

import WorkItemsPage from "./page";

const params = Promise.resolve({ orgSlug: "acme" });

type Boundary = ReactElement<{ fallback: ReactElement; children: ReactElement<object> }>;

function boundary(): Boundary {
  const el = WorkItemsPage({ params }) as Boundary;
  // Cache Components: the default export is a Suspense boundary, and the child
  // inside it does the async work. If that shape changes, say so here rather
  // than failing obscurely below.
  expect(el.type).toBe(Suspense);
  return el;
}

/** Resolve the boundary's child the way the server does, so the test sees the
 *  tree that reaches the browser. */
async function resolvedPage(): Promise<ReactElement> {
  const content = boundary().props.children;
  const Content = content.type as (props: object) => Promise<ReactElement>;
  return Content(content.props);
}

/** The outermost element, which is the one carrying the width cap. */
function outerBox(container: HTMLElement): HTMLElement {
  const el = container.firstElementChild;
  expect(el).toBeInstanceOf(HTMLElement);
  return el as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue({ orgId: "o1", userId: "u1", permissions: 0n });
  getOrgById.mockResolvedValue({ id: "o1", name: "Acme" });
  canViewPage.mockReturnValue(true);
});

afterEach(cleanup);

describe("Work Items page width", () => {
  it("spans the window instead of the 1280px column", async () => {
    const { container } = render(await resolvedPage());
    const box = outerBox(container);

    // Positive controls: this box is the shell, and the table's view is in it.
    // Without them, a class check on the wrong element proves nothing.
    expect(within(box).getByRole("heading", { level: 1, name: "Work Items" })).toBeTruthy();
    expect(within(box).getByTestId("work-items-view")).toBeTruthy();

    expect(box.classList.contains("max-w-full")).toBe(true);
    expect(box.classList.contains("max-w-7xl")).toBe(false);
  });

  it("loads in the same box it renders in, so the page does not jump wider on arrival", async () => {
    const page = outerBox(render(await resolvedPage()).container);
    const skeleton = outerBox(render(boundary().props.fallback).container);

    expect([...skeleton.classList].sort()).toEqual([...page.classList].sort());
  });
});
