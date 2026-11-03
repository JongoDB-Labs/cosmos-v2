// @vitest-environment jsdom
//
// What a browser remembers about a walkthrough between visits. What these pin:
// the step and the asked-about steps survive a reload, each tour keeps its own,
// and anything unreadable in storage means "nothing remembered", never a throw.
import { beforeEach, describe, expect, it } from "vitest";
import { markStepAsked, readAskedSteps, readProgress, writeProgress } from "../progress";

beforeEach(() => window.localStorage.clear());

describe("tour progress", () => {
  it("keeps each tour's step separately", () => {
    writeProgress("a", 4);
    writeProgress("b", 9);
    expect(readProgress("a")).toBe(4);
    expect(readProgress("b")).toBe(9);
    expect(readProgress("c")).toBe(0);
  });

  it("reads junk as nothing remembered", () => {
    window.localStorage.setItem("cosmos:tour-progress", "{not json");
    expect(readProgress("a")).toBe(0);
    window.localStorage.setItem("cosmos:tour-progress", JSON.stringify({ a: "two", b: -1, c: 1.5 }));
    expect([readProgress("a"), readProgress("b"), readProgress("c")]).toEqual([0, 0, 0]);
  });
});

describe("asked-about steps", () => {
  it("remembers each step once, per tour", () => {
    markStepAsked("a", "s1");
    markStepAsked("a", "s1");
    markStepAsked("a", "s3");
    markStepAsked("b", "s2");
    expect([...readAskedSteps("a")]).toEqual(["s1", "s3"]);
    expect([...readAskedSteps("b")]).toEqual(["s2"]);
  });

  it("reads junk as nothing asked", () => {
    window.localStorage.setItem("cosmos:tour-asked", JSON.stringify({ a: "s1", b: [1, "s2"] }));
    expect(readAskedSteps("a").size).toBe(0);
    expect([...readAskedSteps("b")]).toEqual(["s2"]);
    window.localStorage.setItem("cosmos:tour-asked", "[]");
    expect(readAskedSteps("a").size).toBe(0);
  });
});
