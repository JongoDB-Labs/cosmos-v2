// Program Management loads in a skeleton, then the page replaces it. The two
// must sit in the same box or the page jumps when it arrives. The box depends
// on the instance: a framed outside dashboard (PROGRAM_MANAGEMENT_EMBED_URL)
// spans the window, and the built-in page uses the default column. With one
// fixed skeleton, an instance with a framed dashboard loaded narrow and jumped
// wide.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Suspense, type ReactElement } from "react";
import { render, within, cleanup } from "@testing-library/react";
import { Permission } from "@/lib/rbac/permissions";

const { prisma, getAuthContext, connection, loaders } = vi.hoisted(() => {
  const rows = () => ({ findMany: vi.fn(async () => []) });
  return {
    prisma: {
      organization: { findUnique: vi.fn(async () => ({ name: "Acme" })) },
      project: { findMany: vi.fn(async () => [{ id: "p1", key: "ONE", name: "One" }]) },
      goal: rows(),
      risk: rows(),
      deliverable: rows(),
      blocker: rows(),
      changeRequest: rows(),
    },
    getAuthContext: vi.fn(),
    connection: vi.fn(async () => {}),
    loaders: {
      milestones: vi.fn(async () => []),
      kpis: vi.fn(async () => []),
      clins: vi.fn(async () => []),
    },
  };
});

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/rbac/project-access", () => ({ getVisibleProjectIds: async () => new Set(["p1"]) }));
// Which projects the allow/deny rules let through is page.test.tsx's subject; here
// the one project is readable for every register.
vi.mock("@/lib/work-items/query/scope", () => ({ getReadableProjectIds: async () => ["p1"] }));
vi.mock("@/lib/pm/schedule", () => ({ loadMilestonesWithDerived: loaders.milestones }));
vi.mock("@/lib/pm/kpi-derive", () => ({ loadKpisWithDerived: loaders.kpis }));
vi.mock("@/lib/pm/burn", () => ({ loadClinsWithBurn: loaders.clins }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-host": "cosmos.example.com", "x-forwarded-proto": "https" }),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection,
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("redirect");
  }),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));
// The contents have tests of their own. This file is about the box they sit in.
vi.mock("@/components/pm-dashboard/pm-dashboard", () => ({
  PmDashboard: () => <div data-testid="pm-dashboard" />,
}));
vi.mock("./embedded-dashboard", () => ({
  EmbeddedDashboard: () => <div data-testid="embedded-dashboard" />,
}));
vi.mock("./project-picker", () => ({ ProjectPicker: () => null }));
vi.mock("@/components/ui/no-page-access", () => ({
  NoPageAccess: () => <div data-testid="no-page-access" />,
}));

import ProgramManagementPage from "./page";

const DASHBOARD = "https://dashboard.example.com/";
const PROGRAM_ONLY = Permission.ANALYTICS_READ | Permission.PROJECT_READ;
const params = Promise.resolve({ orgSlug: "acme" });
const searchParams = Promise.resolve({});

type Boundary = ReactElement<{ fallback: ReactElement | null; children: ReactElement<object> }>;

/** Walk the page the way the server renders it: the default export is a
 *  Suspense boundary whose child reads the request, and that child returns the
 *  boundary holding the skeleton and the content. If the shape changes, say so
 *  here rather than failing obscurely below. */
async function skeletonBoundary(): Promise<Boundary> {
  const outer = ProgramManagementPage({ params, searchParams }) as Boundary;
  expect(outer.type).toBe(Suspense);
  const child = outer.props.children;
  const inner = await (child.type as (props: object) => Promise<Boundary>)(child.props);
  expect(inner.type).toBe(Suspense);
  return inner;
}

/** The outermost element, which is the one carrying the width cap. */
function outerBox(container: HTMLElement): HTMLElement {
  const el = container.firstElementChild;
  expect(el).toBeInstanceOf(HTMLElement);
  return el as HTMLElement;
}

/** The skeleton's box and the arrived page's box, both rendered for real. */
async function boxes(): Promise<{ skeleton: HTMLElement; page: HTMLElement }> {
  const boundary = await skeletonBoundary();
  const content = boundary.props.children;
  const arrived = await (content.type as (props: object) => Promise<ReactElement>)(content.props);
  const page = outerBox(render(arrived).container);
  const skeleton = outerBox(render(boundary.props.fallback as ReactElement).container);
  // Positive control: the skeleton box really is a skeleton.
  expect(skeleton.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  return { skeleton, page };
}

function classesOf(el: HTMLElement): string[] {
  return [...el.classList].sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PROGRAM_MANAGEMENT_EMBED_URL;
  getAuthContext.mockResolvedValue({ orgId: "o1", userId: "u1", permissions: PROGRAM_ONLY });
});

afterEach(() => {
  cleanup();
  delete process.env.PROGRAM_MANAGEMENT_EMBED_URL;
});

describe("Program Management loads in the box it arrives in", () => {
  it("with a framed dashboard: full width, skeleton and page alike", async () => {
    process.env.PROGRAM_MANAGEMENT_EMBED_URL = DASHBOARD;
    const { skeleton, page } = await boxes();

    // Positive controls: this box is the page, and the frame is in it.
    expect(within(page).getByRole("heading", { level: 1, name: "Program Management" })).toBeTruthy();
    expect(within(page).getByTestId("embedded-dashboard")).toBeTruthy();

    expect(page.classList.contains("max-w-full")).toBe(true);
    expect(classesOf(skeleton)).toEqual(classesOf(page));
  });

  it("with the built-in page: the default column, skeleton and page alike", async () => {
    const { skeleton, page } = await boxes();

    expect(within(page).getByRole("heading", { level: 1, name: "Program Management" })).toBeTruthy();
    expect(within(page).getByTestId("pm-dashboard")).toBeTruthy();

    expect(page.classList.contains("max-w-7xl")).toBe(true);
    // The padding too: the old skeleton's p-8 sat 16px further in on a phone.
    expect(classesOf(skeleton)).toEqual(classesOf(page));
  });

  it("reads the setting when the request arrives, not before", async () => {
    // Under Cache Components a plain process.env read can be fixed at build
    // time, and images are built without this variable. Here the variable
    // only exists once connection() has been awaited, the way it only exists
    // at runtime in production.
    connection.mockImplementationOnce(async () => {
      process.env.PROGRAM_MANAGEMENT_EMBED_URL = DASHBOARD;
    });
    const { skeleton, page } = await boxes();

    expect(connection).toHaveBeenCalledTimes(1);
    expect(within(page).getByTestId("embedded-dashboard")).toBeTruthy();
    expect(skeleton.classList.contains("max-w-full")).toBe(true);
  });

  it("a viewer without access gets the notice in the skeleton's box", async () => {
    process.env.PROGRAM_MANAGEMENT_EMBED_URL = DASHBOARD;
    getAuthContext.mockResolvedValue({ orgId: "o1", userId: "u1", permissions: Permission.PROJECT_READ });
    const { skeleton, page } = await boxes();

    expect(within(page).getByTestId("no-page-access")).toBeTruthy();
    expect(within(page).queryByTestId("embedded-dashboard")).toBeNull();
    expect(classesOf(skeleton)).toEqual(classesOf(page));
  });
});
