"use client";

import { useEffect } from "react";

/**
 * Writes the user's custom background image URLs onto <body> as CSS custom
 * properties. globals.css's body::before reads these via var() so the image
 * swaps without re-rendering the tree. Removing the property on unmount
 * cleanly reverts to the default (/bg-dark.jpeg for dark, none for light).
 *
 * The light-mode overlay is gated on a custom property — when a light bg is
 * set, we expose the tint so foreground UI keeps contrast against the image.
 */
export function BackgroundProvider({
  darkUrl,
  lightUrl,
}: {
  darkUrl?: string | null;
  lightUrl?: string | null;
}) {
  useEffect(() => {
    if (darkUrl) {
      document.body.style.setProperty("--user-bg-dark", `url('${darkUrl}')`);
    } else {
      document.body.style.removeProperty("--user-bg-dark");
    }
    if (lightUrl) {
      document.body.style.setProperty("--user-bg-light", `url('${lightUrl}')`);
      document.body.style.setProperty(
        "--user-bg-light-overlay",
        "rgba(255, 255, 255, 0.65)",
      );
    } else {
      document.body.style.removeProperty("--user-bg-light");
      document.body.style.removeProperty("--user-bg-light-overlay");
    }
    return () => {
      document.body.style.removeProperty("--user-bg-dark");
      document.body.style.removeProperty("--user-bg-light");
      document.body.style.removeProperty("--user-bg-light-overlay");
    };
  }, [darkUrl, lightUrl]);

  return null;
}
