// @vitest-environment node
//
// Resend-backed transactional email sender — the swappable seam
// invitation-email.ts (and any future transactional mail) sends through
// instead of an individual user's personal mailbox. Exercises the real
// global `fetch` via vi.stubGlobal so no network call ever leaves the
// process; asserts the exact request shape Resend expects and the
// throw-on-failure / throw-when-unconfigured contracts callers rely on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTransactionalEmailConfigured, sendAppEmail } from "./email-sender";

const ORIGINAL_ENV = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
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
  it("is true when both RESEND_API_KEY and EMAIL_FROM are set", () => {
    expect(isTransactionalEmailConfigured()).toBe(true);
  });

  it("is false when RESEND_API_KEY is missing", () => {
    setEnv({ RESEND_API_KEY: undefined });
    expect(isTransactionalEmailConfigured()).toBe(false);
  });

  it("is false when EMAIL_FROM is missing", () => {
    setEnv({ EMAIL_FROM: undefined });
    expect(isTransactionalEmailConfigured()).toBe(false);
  });

  it("is false when neither is set", () => {
    setEnv({ RESEND_API_KEY: undefined, EMAIL_FROM: undefined });
    expect(isTransactionalEmailConfigured()).toBe(false);
  });
});

describe("sendAppEmail", () => {
  it("posts to the Resend API with a Bearer auth header and the expected JSON payload", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendAppEmail({
      to: "invitee@example.com",
      subject: "You're invited",
      text: "plain text body",
      html: "<p>html body</p>",
      replyTo: "inviter@example.com",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_test_key",
    );
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
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendAppEmail({
      to: "invitee@example.com",
      subject: "subj",
      text: "text",
      html: "<p>html</p>",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("reply_to");
  });

  it("throws an Error including the HTTP status and response body text on a non-2xx response", async () => {
    const fetchMock = vi.fn(
      async () => new Response("invalid `from` address", { status: 422 }),
    );
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

  it("throws a clear not-configured error and never calls fetch when RESEND_API_KEY is unset", async () => {
    setEnv({ RESEND_API_KEY: undefined });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendAppEmail({ to: "x@example.com", subject: "s", text: "t", html: "<p>h</p>" }),
    ).rejects.toThrow("transactional email not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a clear not-configured error and never calls fetch when EMAIL_FROM is unset", async () => {
    setEnv({ EMAIL_FROM: undefined });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendAppEmail({ to: "x@example.com", subject: "s", text: "t", html: "<p>h</p>" }),
    ).rejects.toThrow("transactional email not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
