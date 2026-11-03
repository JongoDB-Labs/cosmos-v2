// Getting back into a long walkthrough after the session is gone. The closing
// toast's "Resume" does not survive a reload, so what these pin is the way back
// that does: the Walkthroughs menu offers a part-done walkthrough at the step it
// was left on (with "Start over" beside it), and the card's step number is a
// picker that jumps anywhere and marks the steps the reader left feedback or a
// question on.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { TourProvider, useTour } from "../tour-provider";
import { TourCard } from "../tour-card";
import { TourLauncher } from "../tour-launcher";
import type { Tour } from "@/lib/tours/types";

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/acme", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/providers/permissions-provider", () => ({
  usePermissions: () => ({ can: () => true, permissions: 0n }),
}));
vi.mock("@/components/plugins/plugin-slot", () => ({ useEnabledPlugins: () => new Set<string>() }));

const STEPS = Array.from({ length: 12 }, (_, i) => ({ id: `s${i + 1}`, title: `Step ${i + 1}`, blurb: "", look: "" }));
const TOUR: Tour = { id: "t1", name: "Practice", summary: "The whole practice", released: "2026-01-01", steps: STEPS };
vi.mock("@/lib/tours/registry", () => ({ availableTours: () => [TOUR] }));

let feedbackRows: unknown[] = [];

beforeEach(() => {
  window.localStorage.clear();
  feedbackRows = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/feedback?")) return new Response(JSON.stringify(feedbackRows));
    if (u.endsWith("/feedback") && init?.method === "POST") return new Response(JSON.stringify({ id: "f1" }), { status: 201 });
    if (u.endsWith("/conversations")) return new Response(JSON.stringify({ data: { id: "c1" } }));
    if (u.includes("/messages")) return new Response("data: {\"delta\":\"An answer.\"}\n");
    return new Response(null, { status: 204 });
  }));
});

function Shown() {
  const { tour, index } = useTour();
  return <output aria-label="on step">{tour ? index + 1 : "closed"}</output>;
}

const app = (extra?: React.ReactNode) =>
  render(
    <TourProvider>
      <TourLauncher />
      <Shown />
      <TourCard orgId="o1" orgSlug="acme" />
      {extra}
    </TourProvider>,
  );
const onStep = () => screen.getByLabelText("on step").textContent;

describe("the Walkthroughs menu", () => {
  it("offers a walkthrough left part-way back at that step", () => {
    window.localStorage.setItem("cosmos:tour-progress", JSON.stringify({ t1: 6 }));
    app();
    fireEvent.click(screen.getByText("Resume at step 7 of 12"));
    expect(onStep()).toBe("7");
  });

  it("Start over begins at step 1", () => {
    window.localStorage.setItem("cosmos:tour-progress", JSON.stringify({ t1: 6 }));
    app();
    fireEvent.click(screen.getByRole("button", { name: "Start Practice over" }));
    expect(onStep()).toBe("1");
  });

  it("starts at the beginning when nothing was left part-way, or it was finished", () => {
    app();
    expect(screen.queryByRole("button", { name: "Start Practice over" })).toBeNull();
    fireEvent.click(screen.getByText("The whole practice"));
    expect(onStep()).toBe("1");
  });

  it("treats a walkthrough left on its last step as finished", () => {
    window.localStorage.setItem("cosmos:tour-progress", JSON.stringify({ t1: 11 }));
    app();
    expect(screen.queryByText(/Resume at step/)).toBeNull();
  });
});

describe("the step picker", () => {
  it("jumps to any step, and remembers it for the next visit", () => {
    app();
    fireEvent.click(screen.getByText("The whole practice"));
    fireEvent.change(screen.getByRole("combobox", { name: "Go to step" }), { target: { value: "8" } });
    expect(onStep()).toBe("9");
    expect(JSON.parse(window.localStorage.getItem("cosmos:tour-progress")!)).toEqual({ t1: 8 });
  });

  it("marks the steps you left feedback on, and only yours, and only this walkthrough's", async () => {
    feedbackRows = [
      { isMine: true, sourceRef: "t1/s4" },
      { isMine: false, sourceRef: "t1/s5" },
      { isMine: true, sourceRef: "t10/s6" },
    ];
    app();
    fireEvent.click(screen.getByText("The whole practice"));
    const picker = screen.getByRole("combobox", { name: "Go to step" });
    await waitFor(() => expect(within(picker).getByText("4. Step 4 · your feedback")).toBeInTheDocument());
    expect(within(picker).getByText("5. Step 5")).toBeInTheDocument();
    expect(within(picker).getByText("6. Step 6")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toContain(
      "/api/v1/orgs/o1/feedback?source=tour&sourceRef=t1%2F",
    );
  });

  it("marks the steps a question was asked on in this browser", () => {
    window.localStorage.setItem("cosmos:tour-asked", JSON.stringify({ t1: ["s3"] }));
    app();
    fireEvent.click(screen.getByText("The whole practice"));
    const picker = screen.getByRole("combobox", { name: "Go to step" });
    expect(within(picker).getByText("3. Step 3 · you asked")).toBeInTheDocument();
  });

  it("marks a step as soon as a question is asked on it, and remembers it after the card closes", async () => {
    app();
    fireEvent.click(screen.getByText("The whole practice"));
    fireEvent.click(screen.getByRole("button", { name: /Ask about this/ }));
    fireEvent.change(screen.getByLabelText("Ask about Step 1"), { target: { value: "What is this?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const picker = () => screen.getByRole("combobox", { name: "Go to step" });
    await waitFor(() => expect(within(picker()).getByText("1 of 12 · you asked")).toBeInTheDocument());
    expect(JSON.parse(window.localStorage.getItem("cosmos:tour-asked")!)).toEqual({ t1: ["s1"] });
  });

  it("marks a step as soon as feedback on it is sent", async () => {
    app();
    fireEvent.click(screen.getByText("The whole practice"));
    fireEvent.click(screen.getByRole("button", { name: /Feedback/ }));
    fireEvent.change(screen.getByLabelText("Feedback about Step 1"), { target: { value: "Unclear" } });
    // The queue now lists it as theirs, as it would after the POST lands.
    feedbackRows = [{ isMine: true, sourceRef: "t1/s1" }];
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const picker = () => screen.getByRole("combobox", { name: "Go to step" });
    await waitFor(() => expect(within(picker()).getByText("1 of 12 · your feedback")).toBeInTheDocument());
  });
});
