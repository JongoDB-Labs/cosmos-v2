// @vitest-environment node
// src/lib/classification/__tests__/classifier.test.ts
import { describe, it, expect } from "vitest";
import { classifyLikelyCui } from "../classifier";

describe("classifyLikelyCui", () => {
  it("flags content semantically near controlled/defense topics", async () => {
    expect(await classifyLikelyCui("the weapon system targeting parameters and kill chain")).toBe(true);
  }, 60_000);
  it("does NOT flag ordinary business content", async () => {
    expect(await classifyLikelyCui("please schedule a marketing standup for next tuesday")).toBe(false);
  }, 60_000);
});
