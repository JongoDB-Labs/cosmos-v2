// @vitest-environment jsdom
// COSMOS-202 T1 d: the Teams tab's sign-in screen is a page of its own (it is
// all there is before a tab session exists), so it carries the page's main
// landmark and level-one heading, and says what's happening in a live region.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// Outside Teams, initialize never settles.
vi.mock("@microsoft/teams-js", () => ({ app: { initialize: () => new Promise(() => undefined) }, authentication: { getAuthToken: vi.fn() } }));

import { TabSignIn } from "./tab-sign-in";

afterEach(cleanup);

describe("TabSignIn", () => {
  it("is a main landmark with a level-one heading, and announces its state", () => {
    render(<TabSignIn org={null} />);
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Cosmos" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Signing in to Cosmos");
  });
});
