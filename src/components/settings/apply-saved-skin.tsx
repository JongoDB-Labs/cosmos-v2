"use client";
import { useEffect } from "react";

/**
 * Resolves + applies the AUTHORITATIVE skin for the logged-in user:
 *   user skinId  →  org defaultSkinId  →  (nothing)
 * "nothing" here means "keep the deployment default" the no-FOUC script in
 * app/layout.tsx already applied.
 *
 * This does NOT defer to a pre-existing `skin` cookie. That cookie is only a
 * first-paint cache: a browser shared across accounts (e.g. a newly-invited
 * user signing in right after a previous user signed out) can carry a stale,
 * cross-user value that must never win over the logged-in user's real
 * preference. Every mount re-seeds the cookie to the resolved value so the
 * *next* first paint — before this effect can run — also gets it right.
 * Mounted unconditionally by the dashboard layout so the org default still
 * applies for users who never picked their own skin.
 */
export function ApplySavedSkin({
  skinId,
  orgDefaultSkinId,
}: {
  skinId: string | null;
  orgDefaultSkinId?: string | null;
}) {
  useEffect(() => {
    const id = skinId ?? orgDefaultSkinId ?? null;
    if (!id) return; // neither set → keep the deployment default
    const d = document.documentElement;
    d.className = d.className.replace(/\bskin-[\w-]+\b/g, "").trim();
    d.classList.add(`skin-${id}`);
    document.cookie = `skin=${id}; path=/; max-age=${60 * 60 * 24 * 365}`;
  }, [skinId, orgDefaultSkinId]);
  return null;
}
