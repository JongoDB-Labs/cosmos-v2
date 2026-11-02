// src/lib/ai/egress/__tests__/provider.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted so the mock factory can safely reference the spy (avoids the
// "cannot access before initialization" hoisting trap).
const { createMock, clientOpts } = vi.hoisted(() => ({
  createMock: vi.fn(),
  clientOpts: [] as Record<string, unknown>[],
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
    constructor(opts: Record<string, unknown>) {
      clientOpts.push(opts);
    }
  },
}));

const turn = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], model: "claude-sonnet-4-6" };

describe("callModel", () => {
  beforeEach(() => {
    createMock.mockReset();
    clientOpts.length = 0;
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.COSMOS_ALLOW_ENV_MODEL_KEY = "1";
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

  it("refuses the env key without the opt-in: typed error, no SDK call", async () => {
    delete process.env.COSMOS_ALLOW_ENV_MODEL_KEY;
    const { callModel } = await import("../provider");
    const { NoModelCredentialError } = await import("../types");
    const call = callModel(turn);
    await expect(call).rejects.toBeInstanceOf(NoModelCredentialError);
    await expect(call).rejects.toThrow("Claude isn't connected");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("treats any opt-in value but \"1\" as off", async () => {
    process.env.COSMOS_ALLOW_ENV_MODEL_KEY = "true";
    const { callModel } = await import("../provider");
    await expect(callModel(turn)).rejects.toThrow("Claude isn't connected");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("opted in but no key set: the same typed error", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { callModel } = await import("../provider");
    const { NoModelCredentialError } = await import("../types");
    await expect(callModel(turn)).rejects.toBeInstanceOf(NoModelCredentialError);
  });

  it("opted in with a key: the env key is used", async () => {
    vi.resetModules();
    createMock.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] });
    const { callModel } = await import("../provider");
    await expect(callModel(turn)).resolves.toMatchObject({ text: "ok" });
    expect(clientOpts).toEqual([
      { apiKey: "test-key", defaultHeaders: { "anthropic-version": "2023-06-01" } },
    ]);
  });

  it("an oauth credential never sends the env key as x-api-key", async () => {
    createMock.mockResolvedValue({ stop_reason: "end_turn", content: [] });
    const { callModel } = await import("../provider");
    await callModel({ ...turn, credential: { kind: "oauth", token: "sk-ant-oat-x" } });
    expect(clientOpts.at(-1)).toMatchObject({ apiKey: null, authToken: "sk-ant-oat-x" });
  });
});

/**
 * The SDK picks the `anthropic-version` header itself, and its DEFAULT MOVES WITH THE
 * SDK VERSION — 0.137.0 sent `2023-06-01`; 1.0.0's one breaking change was "add support
 * for new API version 2026-10-21". So a routine dependency bump silently re-points every
 * model call at a different server-side API version.
 *
 * Nothing else here can see that. `tsc` sees no change, because the header lives inside
 * the SDK; and this very file mocks the SDK wholesale, so no test observes the wire. The
 * first signal would be a live turn in production returning a shape `callModel` does not
 * read.
 *
 * These specs are therefore the ONLY thing standing between an SDK bump and an
 * unannounced API-version migration. They assert the pin on EVERY path that builds a
 * client — all three, because a pin on two of them is a pin on none.
 */
describe("the Anthropic API version is pinned, not inherited from the SDK", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ stop_reason: "end_turn", content: [] });
    clientOpts.length = 0;
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.COSMOS_ALLOW_ENV_MODEL_KEY = "1";
  });

  it("pins it on the env-key client", async () => {
    vi.resetModules(); // the env client is module-cached
    const { callModel } = await import("../provider");
    await callModel(turn);
    expect(clientOpts.at(-1)?.defaultHeaders).toEqual({ "anthropic-version": "2023-06-01" });
  });

  it("pins it on the oauth client, WITHOUT dropping the oauth beta header", async () => {
    // Both headers share one `defaultHeaders` object, so adding the version pin is
    // exactly where the beta header would get clobbered. Assert both survive together.
    const { callModel } = await import("../provider");
    await callModel({ ...turn, credential: { kind: "oauth", token: "sk-ant-oat-x" } });
    expect(clientOpts.at(-1)?.defaultHeaders).toEqual({
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
    });
  });

  it("pins it on the per-org api-key client", async () => {
    const { callModel } = await import("../provider");
    await callModel({ ...turn, credential: { kind: "apiKey", apiKey: "sk-ant-org" } });
    expect(clientOpts.at(-1)).toMatchObject({
      apiKey: "sk-ant-org",
      authToken: null,
      defaultHeaders: { "anthropic-version": "2023-06-01" },
    });
  });

  it("pins the SAME version on every path", async () => {
    // A per-path literal would let one client drift. Collect them and assert one value.
    vi.resetModules();
    const { callModel } = await import("../provider");
    await callModel(turn);
    await callModel({ ...turn, credential: { kind: "oauth", token: "t" } });
    await callModel({ ...turn, credential: { kind: "apiKey", apiKey: "k" } });

    const versions = clientOpts.map(
      (o) => (o.defaultHeaders as Record<string, string> | undefined)?.["anthropic-version"],
    );
    expect(versions).toHaveLength(3);
    expect(new Set(versions)).toEqual(new Set(["2023-06-01"]));
  });
});
