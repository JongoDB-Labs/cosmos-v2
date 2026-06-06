// src/lib/ai/egress/__tests__/provider.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted so the mock factory can safely reference the spy (avoids the
// "cannot access before initialization" hoisting trap).
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
    constructor(_opts: unknown) {}
  },
}));

describe("callModel", () => {
  beforeEach(() => {
    createMock.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("maps a tool_use response into {text, toolUses, stopReason}", async () => {
    createMock.mockResolvedValue({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "tu_1", name: "list_projects", input: { limit: 5 } },
      ],
    });
    const { callModel } = await import("../provider");
    const r = await callModel({
      system: "you are cosmos",
      messages: [{ role: "user", content: "list my projects" }],
      tools: [{ name: "list_projects", description: "list", input_schema: { type: "object", properties: {} } }],
      model: "claude-sonnet-4-6",
    });
    expect(r.text).toBe("Let me check.");
    expect(r.toolUses).toEqual([{ id: "tu_1", name: "list_projects", input: { limit: 5 } }]);
    expect(r.stopReason).toBe("tool_use");
    // Sanity: tools were forwarded natively (not as a TOOL_CALL text protocol).
    expect(createMock.mock.calls[0][0].tools[0].name).toBe("list_projects");
  });

  it("throws a clear error when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { callModel } = await import("../provider");
    await expect(
      callModel({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], model: "claude-sonnet-4-6" }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
