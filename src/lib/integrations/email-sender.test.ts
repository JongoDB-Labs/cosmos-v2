// @vitest-environment node
//
// Resend-backed transactional email sender — the swappable seam
// invitation-email.ts (and any future transactional mail) sends through instead
// of an individual user's personal mailbox. Exercises the real global `fetch` via
// vi.stubGlobal so no network call ever leaves the process; asserts the exact
// request shape Resend expects, the throw-on-failure / throw-when-unconfigured
// contracts, AND the config-resolution precedence: a usable PER-ORG config
// (mocked getOrgEmailConfig) wins, else the deployment-wide env is used. The
// per-org config lookup is mocked so this file never touches prisma/the vault.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getOrgEmailConfig } = vi.hoisted(() => ({ getOrgEmailConfig: vi.fn() }));
vi.mock("./org-email-config", () => ({ getOrgEmailConfig }));

import { isTransactionalEmailConfigured, sendAppEmail } from "./email-sender";

const ORIGINAL_ENV = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const ORG_CONFIG = {
  apiKey: "re_perorg_key",
  from: "Acme <team@acme.example>",
  provider: "resend",
};

beforeEach(() => {
  getOrgEmailConfig.mockReset();
  getOrgEmailConfig.mockResolvedValue(null); // default: org has NO usable per-org config
  setEnv({
    RESEND_API_KEY: "re_test_key",
    EMAIL_FROM: "Cosmos <invites@example.com>",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("isTransactionalEmailConfigured", () => {
  it("is true when both RESEND_API_KEY and EMAIL_FROM are set (no orgId)", async () => {
    expect(await isTransactionalEmailConfigured()).toBe(true);
  });

  it("is false when RESEND_API_KEY is missing (no orgId)", async () => {
    setEnv({ RESEND_API_KEY: undefined });
    expect(await isTransactionalEmailConfigured()).toBe(false);
  });

  it("is false when EMAIL_FROM is missing (no orgId)", async () => {
    setEnv({ EMAIL_FROM: undefined });
    expect(await isTransactionalEmailConfigured()).toBe(false);
  });

  it("is false when neither env is set and no orgId is given", async () => {
    setEnv({ RESEND_API_KEY: undefined, EMAIL_FROM: undefined });
    expect(await isTransactionalEmailConfigured()).toBe(false);
  });

  it("is true when a PER-ORG config exists even though env is unset", async () => {
    setEnv({ RESEND_API_KEY: undefined, EMAIL_FROM: undefined });
    getOrgEmailConfig.mockResolvedValue(ORG_CONFIG);

    expect(await isTransactionalEmailConfigured("org-1")).toBe(true);
    expect(getOrgEmailConfig).toHaveBeenCalledWith("org-1");
  });

  it("falls back to env when an orgId is given but the org has no usable config", async () => {
    getOrgEmailConfig.mockResolvedValue(null);
    expect(await isTransactionalEmailConfigured("org-1")).toBe(true); // env still set
  });
});

describe("sendAppEmail — config resolution precedence", () => {
  function okFetch() {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("uses the PER-ORG sealed key + From when the org has a usable config (env ignored)", async () => {
    getOrgEmailConfig.mockResolvedValue(ORG_CONFIG);
    const fetchMock = okFetch();

    await sendAppEmail({
      to: "invitee@example.com",
      subject: "subj",
      text: "t",
      html: "<p>h</p>",
      orgId: "org-1",
    });

    expect(getOrgEmailConfig).toHaveBeenCalledWith("org-1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_perorg_key");
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: "Acme <team@acme.example>",
      to: "invitee@example.com",
    });
  });

  it("falls back to the ENV key + From when an orgId is given but there is no per-org config", async () => {
    getOrgEmailConfig.mockResolvedValue(null);
    const fetchMock = okFetch();

    await sendAppEmail({
      to: "invitee@example.com",
      subject: "subj",
      text: "t",
      html: "<p>h</p>",
      orgId: "org-1",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: "Cosmos <invites@example.com>",
    });
  });

  it("uses the ENV key + From when no orgId is given, and never consults the per-org lookup", async () => {
    const fetchMock = okFetch();

    await sendAppEmail({
      to: "invitee@example.com",
      subject: "You're invited",
      text: "plain text body",
      html: "<p>html body</p>",
      replyTo: "inviter@example.com",
    });

    expect(getOrgEmailConfig).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    expect(JSON.parse(init.body as string)).toEqual({
      from: "Cosmos <invites@example.com>",
      to: "invitee@example.com",
      subject: "You're invited",
      text: "plain text body",
      html: "<p>html body</p>",
      reply_to: "inviter@example.com",
    });
  });

  it("omits reply_to entirely when not given", async () => {
    const fetchMock = okFetch();

    await sendAppEmail({ to: "invitee@example.com", subject: "subj", text: "text", html: "<p>html</p>" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("reply_to");
  });
});

describe("sendAppEmail — failure contracts", () => {
  it("throws an Error including the HTTP status and response body text on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("invalid `from` address", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await sendAppEmail({ to: "x@example.com", subject: "s", text: "t", html: "<p>h</p>" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("422");
    expect((caught as Error).message).toContain("invalid `from` address");
  });

  it("throws a clear not-configured error and never calls fetch when RESEND_API_KEY is unset (no orgId)", async () => {
    setEnv({ RESEND_API_KEY: undefined });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendAppEmail({ to: "x@example.com", subject: "s", text: "t", html: "<p>h</p>" }),
    ).rejects.toThrow("transactional email not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a clear not-configured error and never calls fetch when EMAIL_FROM is unset (no orgId)", async () => {
    setEnv({ EMAIL_FROM: undefined });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendAppEmail({ to: "x@example.com", subject: "s", text: "t", html: "<p>h</p>" }),
    ).rejects.toThrow("transactional email not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws not-configured when an orgId has no per-org config AND env is unset", async () => {
    setEnv({ RESEND_API_KEY: undefined, EMAIL_FROM: undefined });
    getOrgEmailConfig.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendAppEmail({ to: "x@example.com", subject: "s", text: "t", html: "<p>h</p>", orgId: "org-1" }),
    ).rejects.toThrow("transactional email not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
