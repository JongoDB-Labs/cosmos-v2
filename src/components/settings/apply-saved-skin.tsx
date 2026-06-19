"use client";
import { useEffect } from "react";

export function ApplySavedSkin({ skinId }: { skinId: string }) {
  useEffect(() => {
    if (document.cookie.match(/(^| )skin=/)) return; // existing cookie wins
    const d = document.documentElement;
    d.className = d.className.replace(/\bskin-[\w-]+\b/g, "").trim();
    d.classList.add(`skin-${skinId}`);
    document.cookie = `skin=${skinId}; path=/; max-age=${60 * 60 * 24 * 365}`;
  }, [skinId]);
  return null;
}
