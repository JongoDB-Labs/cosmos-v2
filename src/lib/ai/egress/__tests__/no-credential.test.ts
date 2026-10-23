// src/lib/ai/egress/__tests__/no-credential.test.ts
//
// With no model credential the chokepoint fails with the typed
// NoModelCredentialError, never a fallback to the env key: both when nothing is
// configured and when resolving the credential throws.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock, resolveOrgModelCredential } = vi.hoisted(() => ({
  createMock: vi.fn(),
  resolveOrgModelCredential: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));
vi.mock("@/lib/classification/effective", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  effectiveCeiling: vi.fn().mockResolvedValue("UNCLASSIFIED"),
}));
vi.mock("@/lib/ai/egress/audit", () => ({ logEgressDecision: vi.fn() }));
vi.mock("@/lib/ai/ai-credentials", () => ({ resolveOrgModelCredential }));

import { runModelTurn, NoModelCredentialError } from "@/lib/ai/egress";
import { handleApiError } from "@/lib/api-helpers";

const input = {
  ctx: {
    orgId: "org-x",
    conversationId: "c",
    turn: 1,
    tenantClass: "commercial" as const,
    mode: "enforced" as const,
  },
  system: "you are cosmos",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [],
  model: "claude-sonnet-4-6",
};

describe("no model credential", () => {
  beforeEach(() => {
    createMock
      .mockReset()
      .mockResolvedValue({ stop_reason: "end_turn", content: [] });
    resolveOrgModelCredential.mockReset();
    process.env.ANTHROPIC_API_KEY = "stale-prod-key";
    delete process.env.COSMOS_ALLOW_ENV_MODEL_KEY;
  });

  it("none configured: typed error, the stale env key is never used", async () => {
    resolveOrgModelCredential.mockResolvedValue(undefined);
    await expect(runModelTurn(input)).rejects.toBeInstanceOf(
      NoModelCredentialError,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("resolution throws: typed error, not a degrade to the env key", async () => {
    resolveOrgModelCredential.mockRejectedValue(new Error("db down"));
    process.env.COSMOS_ALLOW_ENV_MODEL_KEY = "1";
    await expect(runModelTurn(input)).rejects.toBeInstanceOf(
      NoModelCredentialError,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("an API route answers 409 model_not_connected with the user-facing message", async () => {
    const res = handleApiError(new NoModelCredentialError());
    expect(res.status).toBe(409);
    // problem+json; the legacy `error` text and `code` are what callers read.
    expect(await res.json()).toMatchObject({
      error:
        "Claude isn't connected. Connect a Claude subscription in Settings → AI / Model.",
      code: "model_not_connected",
    });
  });
});
