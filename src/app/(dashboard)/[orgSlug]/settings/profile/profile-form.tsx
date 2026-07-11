"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { enablePushNotifications, disablePushNotifications } from "@/lib/notifications/subscribe";
import { jsonFetch } from "@/lib/query/json-fetcher";
import {
  MAX_AVATAR_DATAURL_BYTES,
  MAX_AVATAR_SOURCE_BYTES,
  MAX_AVATAR_SOURCE_MB,
} from "@/lib/security/image-url";

interface ProfileFormProps {
  initial: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  };
}

/** Downscale + JPEG-compress a data URL until its string length fits `cap`.
 *  Caps the longest edge at 512px (ample for an avatar) and steps quality down. */
async function downscaleAvatar(srcDataUrl: string, cap: number): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("decode failed"));
    i.src = srcDataUrl;
  });
  const maxDim = 512;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (Math.max(w, h) > maxDim) {
    const s = maxDim / Math.max(w, h);
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const cx = canvas.getContext("2d");
  if (!cx) return srcDataUrl;
  cx.drawImage(img, 0, 0, w, h);
  let out = srcDataUrl;
  for (const q of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
    out = canvas.toDataURL("image/jpeg", q);
    if (out.length <= cap) break;
  }
  return out;
}

export function ProfileForm({ initial }: ProfileFormProps) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initial.avatarUrl);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  const saveProfile = useMutation({
    mutationFn: (payload: { displayName: string; avatarUrl: string | null }) =>
      jsonFetch("/api/v1/me", {
        method: "PATCH",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      router.refresh();
    },
    onError: (e: Error) => setError(e.message),
  });

  const pending = saveProfile.isPending;
  const [pushState, setPushState] = useState<"unknown" | "unsupported" | "subscribed" | "unsubscribed">("unknown");
  const [pushPending, setPushPending] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (typeof window === "undefined") return;
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        if (!cancelled) setPushState("unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        if (!cancelled) setPushState("unsubscribed");
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration("/push-sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (!cancelled) setPushState(sub ? "subscribed" : "unsubscribed");
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function togglePush() {
    setPushPending(true);
    setError(null);
    try {
      if (pushState === "subscribed") {
        await disablePushNotifications();
        setPushState("unsubscribed");
      } else if (pushState === "unsubscribed") {
        const result = await enablePushNotifications();
        if (result.ok) {
          setPushState("subscribed");
        } else {
          // Accurate, cause-specific messaging — don't blame browser
          // permission when the server simply has no VAPID keys.
          setError(
            result.reason === "not_configured"
              ? "Push notifications aren't configured on this server yet. Ask your administrator to set the VAPID keys."
              : result.reason === "denied"
                ? "Notifications are blocked for this site. Enable them in your browser's site settings, then try again."
                : result.reason === "unsupported"
                  ? "Your browser doesn't support push notifications."
                  : "Couldn't enable notifications. Please try again.",
          );
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update push subscription");
    }
    setPushPending(false);
  }

  async function handleFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setError("Only images are accepted");
      return;
    }
    if (file.size > MAX_AVATAR_SOURCE_BYTES) {
      setError(
        `That image is too large (${Math.round(file.size / 1_000_000)}MB). Pick one under ${MAX_AVATAR_SOURCE_MB}MB.`,
      );
      return;
    }
    setError(null);
    try {
      let dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      // Big photos are downscaled to fit instead of rejected — the whole point of
      // the FR. (Small images pass through untouched, preserving their format.)
      if (dataUrl.length > MAX_AVATAR_DATAURL_BYTES) {
        dataUrl = await downscaleAvatar(dataUrl, MAX_AVATAR_DATAURL_BYTES);
      }
      if (dataUrl.length > MAX_AVATAR_DATAURL_BYTES) {
        setError("Couldn't compress that image small enough — try a simpler one.");
        return;
      }
      setAvatarUrl(dataUrl);
    } catch {
      setError("Couldn't read that image. Try a different file.");
    }
  }

  function save() {
    setError(null);
    setErrors({});

    const next: Record<string, string> = {};
    if (!displayName.trim()) {
      next.displayName = "Display name is required";
    }

    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    saveProfile.mutate({ displayName, avatarUrl });
  }

  const initials = displayName
    .split(" ")
    .map((s) => s[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="space-y-6 max-w-md">
      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
          Avatar
        </p>
        <div className="flex items-center gap-4">
          <Avatar className="h-16 w-16">
            <AvatarImage src={avatarUrl ?? undefined} />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() => fileInput.current?.click()}
              disabled={pending}
            >
              Upload image
            </Button>
            {avatarUrl && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setAvatarUrl(null)}
                disabled={pending}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          PNG/JPG/WEBP up to {MAX_AVATAR_SOURCE_MB}MB — large images are resized automatically.
        </p>
      </div>

      <FormField label="Display name" required error={errors.displayName}>
        {(p) => (
          <Input
            {...p}
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              if (errors.displayName) {
                setErrors((prev) => {
                  const rest = { ...prev };
                  delete rest.displayName;
                  return rest;
                });
              }
            }}
            disabled={pending}
          />
        )}
      </FormField>

      <FormField label="Email" hint="Email is set by your Google account and can't be changed here.">
        {(p) => <Input {...p} value={initial.email} disabled />}
      </FormField>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
          Browser notifications
        </p>
        {pushState === "unsupported" ? (
          <p className="text-sm text-[var(--text-muted)]">Your browser doesn&apos;t support push notifications.</p>
        ) : pushState === "unknown" ? (
          <p className="text-sm text-[var(--text-muted)]">Checking…</p>
        ) : (
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={togglePush}
              disabled={pushPending}
            >
              {pushPending
                ? "…"
                : pushState === "subscribed"
                  ? "Disable push notifications"
                  : "Enable push notifications"}
            </Button>
            <span className={
              pushState === "subscribed"
                ? "text-xs text-[var(--status-done)]"
                : "text-xs text-[var(--text-muted)]"
            }>
              {pushState === "subscribed" ? "On" : "Off"}
            </span>
          </div>
        )}
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Get desktop notifications when someone assigns you a task or mentions you.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-[var(--status-critical)]/30 bg-[var(--status-critical)]/10 px-3 py-2 text-sm text-[var(--status-critical)]">
          {error}
        </div>
      )}

      <Button onClick={save} disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}
