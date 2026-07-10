// @vitest-environment node
//
// FR "Default view" (COSMOS-7): the project landing page resolves WHICH tab a
// member lands on. The manager-configured project default (Project.settings.
// defaultTab) must catch members who have no personal override, a member's OWN
// default must still win, and an unconfigured project must fall through to the
// first board. These are the user-facing guarantees of the feature; this test
// pins the resolution order so a future refactor can't silently drop them.
//
// Harness: mock the I/O boundaries (prisma, getAuthContext) and next/navigation
// (redirect/notFound THROW, exactly like the real ones), then call the default
// export directly. The first matching redirect throws and halts — mirroring the
// real control flow — so we assert on which URL `redirect` was handed.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma, getAuthContext, redirect, notFound } = vi.hoisted(() => ({
  prisma: {
    project: { findFirst: vi.fn() },
    userPreferences: { findUnique: vi.fn() },
  },
  getAuthContext: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("next/navigation", () => ({ redirect, notFound }));
// Only rendered in the no-boards empty state (never on the redirect paths here);
// stub it so importing the page doesn't pull the UI tree into the node env.
vi.mock("@/components/ui/page-shell", () => ({ PageShell: () => null }));

import ProjectPage from "./page";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
const BOARD_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BOARD_2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const params = Promise.resolve({ orgSlug: "acme", projectKey: "PROJ" });

/** Seed the project row the page loads (boards come back id-only, sorted). */
function mockProject(opts: {
  settings?: Record<string, unknown>;
  enabledFeatures?: string[];
}) {
  prisma.project.findFirst.mockResolvedValue({
    id: PROJECT_ID,
    name: "Proj",
    description: null,
    settings: opts.settings ?? {},
    enabledFeatures: opts.enabledFeatures ?? [],
    boards: [{ id: BOARD_1 }, { id: BOARD_2 }],
  });
}

/** Run the page and return the URL `redirect()` was called with (or null). */
async function landUrl(): Promise<string | null> {
  try {
    await ProjectPage({ params });
  } catch {
    // redirect()/notFound() throw by design — swallow and inspect the mock.
  }
  const call = redirect.mock.calls.at(-1);
  return call ? (call[0] as string) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue({ userId: USER_ID, orgId: ORG_ID });
  prisma.userPreferences.findUnique.mockResolvedValue(null);
});

describe("ProjectPage default-view resolution (COSMOS-7)", () => {
  it("a member without a personal override lands on the project-configured default board", async () => {
    mockProject({ settings: { defaultTab: `board:${BOARD_2}` } });

    expect(await landUrl()).toBe(`/acme/projects/PROJ/boards/${BOARD_2}`);
  });

  it("resolves a project-level feature default to that feature's route", async () => {
    mockProject({ settings: { defaultTab: "feature:okr" }, enabledFeatures: ["okr"] });

    expect(await landUrl()).toBe("/acme/projects/PROJ/okrs");
  });

  it("a member's OWN default wins over the project default", async () => {
    mockProject({ settings: { defaultTab: `board:${BOARD_2}` } });
    prisma.userPreferences.findUnique.mockResolvedValue({
      tabPrefs: { [PROJECT_ID]: { defaultTab: `board:${BOARD_1}` } },
      defaultBoardId: null,
    });

    expect(await landUrl()).toBe(`/acme/projects/PROJ/boards/${BOARD_1}`);
  });

  it("falls back to the first board when no default is configured anywhere", async () => {
    mockProject({ settings: {} });

    expect(await landUrl()).toBe(`/acme/projects/PROJ/boards/${BOARD_1}`);
  });

  it("ignores a project default that points at a deleted board and falls through", async () => {
    mockProject({ settings: { defaultTab: "board:deleted-board-id" } });

    expect(await landUrl()).toBe(`/acme/projects/PROJ/boards/${BOARD_1}`);
  });
});
