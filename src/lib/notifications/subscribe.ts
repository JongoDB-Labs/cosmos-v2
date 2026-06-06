"use client";

/**
 * Register the service worker and subscribe to push notifications.
 * Returns the PushSubscription if successful, null on user denial or unsupported.
 */
export async function enablePushNotifications(): Promise<PushSubscription | null> {
  if (typeof window === "undefined") return null;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return null;
  }

  const reg = await navigator.serviceWorker.register("/push-sw.js");
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;

  // Fetch VAPID public key
  const res = await fetch("/api/v1/me/push/subscribe", { method: "GET" });
  if (!res.ok) return null;
  const { data } = (await res.json()) as { data: { publicKey: string } };

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(data.publicKey) as BufferSource,
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

  if (!persistRes.ok) return null;
  return sub;
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
