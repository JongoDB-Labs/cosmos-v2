// @vitest-environment jsdom
//
// Per-org email-delivery control. Proves:
//   - a non-owner sees a read-only summary with NO inputs;
//   - the OWNER sees the form; the API-key field is WRITE-ONLY — it starts empty
//     and shows a "Configured ••••" placeholder (never the stored key) when a key
//     is already stored;
//   - Save PUTs the expected body, and OMITS apiKey when the field is left blank
//     (so the stored key is left untouched) but INCLUDES it when a new key is typed;
//   - an invalid From address is blocked client-side (no request);
//   - Send test POSTs and renders the result inline.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { OrgEmailDelivery, type OrgEmailDeliveryInitial } from "./org-email-delivery";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const notifyError = vi.fn();
vi.mock("@/lib/errors/notify", () => ({ notifyError: (...a: unknown[]) => notifyError(...a) }));

const ORG_ID = "org-123";

const NOT_CONFIGURED: OrgEmailDeliveryInitial = {
  provider: "resend",
  fromAddress: null,
  enabled: false,
  configured: false,
};
const CONFIGURED: OrgEmailDeliveryInitial = {
  provider: "resend",
  fromAddress: "Acme <invites@acme.com>",
  enabled: true,
  configured: true,
};

function mockFetch(body: unknown = {}) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => vi.clearAllMocks());

describe("OrgEmailDelivery — non-owner", () => {
  it("renders a read-only summary with no inputs or save/test buttons", () => {
    render(<OrgEmailDelivery orgId={ORG_ID} isOwner={false} initial={CONFIGURED} />);

    expect(screen.getByText(/only the organization owner can change/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send test email/i })).not.toBeInTheDocument();
  });
});

describe("OrgEmailDelivery — OWNER, write-only key", () => {
  it("key field starts empty with a 're_…' placeholder when nothing is stored", () => {
    render(<OrgEmailDelivery orgId={ORG_ID} isOwner initial={NOT_CONFIGURED} />);

    const key = screen.getByLabelText(/api key/i) as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.getAttribute("type")).toBe("password");
    expect(key.getAttribute("placeholder")).toBe("re_…");
  });

  it("key field is empty with a 'Configured ••••' placeholder when a key is stored (never renders the key)", () => {
    render(<OrgEmailDelivery orgId={ORG_ID} isOwner initial={CONFIGURED} />);

    const key = screen.getByLabelText(/api key/i) as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.getAttribute("placeholder")).toBe("Configured ••••");
  });
});

describe("OrgEmailDelivery — OWNER save", () => {
  it("PUTs provider/fromAddress/enabled AND the typed apiKey", async () => {
    const fetchMock = mockFetch({ provider: "resend", fromAddress: "a@b.com", enabled: true, configured: true });
    render(<OrgEmailDelivery orgId={ORG_ID} isOwner initial={NOT_CONFIGURED} />);

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "re_new_key" } });
    fireEvent.change(screen.getByLabelText(/from address/i), { target: { value: "invites@acme.com" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/v1/orgs/${ORG_ID}/email-settings`);
    expect((opts as RequestInit).method).toBe("PUT");
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
      provider: "resend",
      fromAddress: "invites@acme.com",
      enabled: false,
      apiKey: "re_new_key",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("OMITS apiKey from the PUT when the field is left blank (leaves the stored key untouched)", async () => {
    const fetchMock = mockFetch({ ...CONFIGURED });
    render(<OrgEmailDelivery orgId={ORG_ID} isOwner initial={CONFIGURED} />);

    // Don't touch the key field; just re-save.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("apiKey");
    expect(body).toEqual({
      provider: "resend",
      fromAddress: "Acme <invites@acme.com>",
      enabled: true,
    });
  });

  it("blocks an invalid From address client-side (no request)", async () => {
    const fetchMock = mockFetch();
    render(<OrgEmailDelivery orgId={ORG_ID} isOwner initial={NOT_CONFIGURED} />);

    fireEvent.change(screen.getByLabelText(/from address/i), { target: { value: "not-an-email" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/enter an email like/i)).toBeInTheDocument();
  });
});

describe("OrgEmailDelivery — OWNER send test", () => {
  it("POSTs the test route and renders the success result inline", async () => {
    const fetchMock = mockFetch({ ok: true });
    render(<OrgEmailDelivery orgId={ORG_ID} isOwner initial={CONFIGURED} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /send test email/i }));
    });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/v1/orgs/${ORG_ID}/email-settings/test`);
    expect((opts as RequestInit).method).toBe("POST");
    expect(screen.getByText(/test email sent/i)).toBeInTheDocument();
  });

  it("renders the provider error inline when the test result is not ok", async () => {
    const fetchMock = mockFetch({ ok: false, error: "Resend rejected the API key" });
    render(<OrgEmailDelivery orgId={ORG_ID} isOwner initial={CONFIGURED} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /send test email/i }));
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.getByText(/resend rejected the api key/i)).toBeInTheDocument();
  });
});
