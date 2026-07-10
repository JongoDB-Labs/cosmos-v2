import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enablePushNotifications } from "./subscribe";

// A valid base64url string so urlBase64ToUint8Array()'s atob() doesn't throw.
const VALID_PUBLIC_KEY = btoa("x".repeat(65))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

function fakeSubscription() {
  return {
    toJSON: () => ({
      endpoint: "https://push.example.com/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-key" },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  } as unknown as PushSubscription;
}

let subscribeMock: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

/** Wire up a fetch mock for the GET (VAPID key) + POST (persist) round-trip. */
function mockFetch(opts: {
  getBody?: unknown;
  getStatus?: number;
  postOk?: boolean;
}) {
  const { getBody, getStatus = 200, postOk = true } = opts;
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return Promise.resolve({
        ok: getStatus >= 200 && getStatus < 300,
        status: getStatus,
        json: async () => getBody,
      } as Response);
    }
    return Promise.resolve({
      ok: postOk,
      status: postOk ? 200 : 500,
      json: async () => ({}),
    } as Response);
  });
}

beforeEach(() => {
  subscribeMock = vi.fn().mockResolvedValue(fakeSubscription());
  const reg = {
    pushManager: {
      subscribe: subscribeMock,
      getSubscription: vi.fn().mockResolvedValue(null),
    },
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn().mockResolvedValue(reg),
      ready: Promise.resolve(reg),
      getRegistration: vi.fn().mockResolvedValue(reg),
    },
  });
  (window as unknown as { PushManager: unknown }).PushManager = function () {};
  vi.stubGlobal("Notification", {
    permission: "default",
    requestPermission: vi.fn().mockResolvedValue("granted"),
  });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  vi.restoreAllMocks();
});

describe("enablePushNotifications", () => {
  it("enables successfully when the VAPID key comes back in the bare success() shape", async () => {
    // Regression: success() returns `{ publicKey }`, NOT `{ data: { publicKey } }`.
    // Reading `.data.publicKey` made this fail with a bogus "not configured"
    // error even after the user granted permission.
    mockFetch({ getBody: { publicKey: VALID_PUBLIC_KEY } });

    const result = await enablePushNotifications();

    expect(result.ok).toBe(true);
    expect(subscribeMock).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    // Persisted the subscription to the server (GET + POST).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("also accepts the wrapped { data: { publicKey } } shape", async () => {
    mockFetch({ getBody: { data: { publicKey: VALID_PUBLIC_KEY } } });

    const result = await enablePushNotifications();

    expect(result.ok).toBe(true);
  });

  it("reports not_configured when the server has no VAPID keys (503)", async () => {
    mockFetch({ getStatus: 503, getBody: { error: "push_not_configured" } });

    const result = await enablePushNotifications();

    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it("reports denied when the user does not grant permission", async () => {
    (Notification.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue(
      "denied",
    );
    mockFetch({ getBody: { publicKey: VALID_PUBLIC_KEY } });

    const result = await enablePushNotifications();

    expect(result).toEqual({ ok: false, reason: "denied" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports error (not denied/not_configured) when persisting the subscription fails", async () => {
    mockFetch({ getBody: { publicKey: VALID_PUBLIC_KEY }, postOk: false });

    const result = await enablePushNotifications();

    expect(result).toEqual({ ok: false, reason: "error" });
  });
});
