"use client";
import { useEffect } from "react";

/**
 * Seeds the `skin` cookie + <html> class from the resolution order
 *   existing `skin` cookie  →  user skinId  →  org defaultSkinId  →  (nothing)
 * The no-FOUC script in app/layout.tsx already applied the deployment default
 * (and honors any cookie), so "nothing" here means "keep the deployment
 * default". Mounted unconditionally by the dashboard layout so the org default
 * still applies for users who never picked their own skin.
 */
export function ApplySavedSkin({
  skinId,
  orgDefaultSkinId,
}: {
  skinId: string | null;
  orgDefaultSkinId?: string | null;
}) {
  useEffect(() => {
    if (document.cookie.match(/(^| )skin=/)) return; // existing cookie wins
    const id = skinId ?? orgDefaultSkinId ?? null;
    if (!id) return; // neither set → keep the deployment default
    const d = document.documentElement;
    d.className = d.className.replace(/\bskin-[\w-]+\b/g, "").trim();
    d.classList.add(`skin-${id}`);
    document.cookie = `skin=${id}; path=/; max-age=${60 * 60 * 24 * 365}`;
  }, [skinId, orgDefaultSkinId]);
  return null;
}
