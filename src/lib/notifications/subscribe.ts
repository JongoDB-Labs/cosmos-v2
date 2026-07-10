"use client";

/**
 * Why an enable attempt failed, so the UI can show an ACCURATE message instead
 * of always blaming browser permission. `not_configured` = the server has no
 * VAPID keys (GET returns 503); `denied` = the user blocked notifications;
 * `unsupported` = no Service Worker / PushManager; `error` = anything else.
 */
export type PushEnableResult =
  | { ok: true; sub: PushSubscription }
  | { ok: false; reason: "unsupported" | "denied" | "not_configured" | "error" };

/**
 * Register the service worker and subscribe to push notifications.
 * Returns a discriminated result so callers can explain a failure precisely.
 */
export async function enablePushNotifications(): Promise<PushEnableResult> {
  if (typeof window === "undefined") return { ok: false, reason: "unsupported" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, reason: "unsupported" };
  }

  try {
    const reg = await navigator.serviceWorker.register("/push-sw.js");
    await navigator.serviceWorker.ready;

    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, reason: "denied" };

    // Fetch VAPID public key. A 503 here means the deployment has no VAPID
    // keys configured — surface that distinctly so we don't tell the user to
    // "check browser permissions" when the server is the problem.
    const res = await fetch("/api/v1/me/push/subscribe", { method: "GET" });
    if (res.status === 503) return { ok: false, reason: "not_configured" };
    if (!res.ok) return { ok: false, reason: "error" };
    // `success()` returns the bare payload (`{ publicKey }`); other routes wrap
    // it as `{ data: { publicKey } }`. Accept BOTH shapes — reading only the
    // wrapped `.data.publicKey` here was the bug that made every enable attempt
    // fail with a misleading "not configured" error even right after the user
    // clicked "Allow", because the real body has no `data` key.
    const body = (await res.json()) as {
      publicKey?: string;
      data?: { publicKey?: string };
    };
    const publicKey = body.publicKey ?? body.data?.publicKey;
    if (!publicKey) return { ok: false, reason: "not_configured" };

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });

    // Persist to server
    const subRaw = sub.toJSON();
    const persistRes = await fetch("/api/v1/me/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: subRaw.endpoint!,
        keys: { p256dh: subRaw.keys!.p256dh, auth: subRaw.keys!.auth },
      }),
    });

    if (!persistRes.ok) return { ok: false, reason: "error" };
    return { ok: true, sub };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export async function disablePushNotifications(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration("/push-sw.js");
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const subRaw = sub.toJSON();
  await fetch("/api/v1/me/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subRaw.endpoint }),
  });
  await sub.unsubscribe();
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
