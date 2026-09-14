"use client";

import { usePathname } from "next/navigation";
import { TourCard } from "./tour-card";

/**
 * Renders the tour card for whichever org the reader is in.
 *
 * The slug comes from the path rather than a prop: this mounts in the org
 * layout, which is a server component, and threading an awaited param through
 * to a client island for a value already in the URL is more machinery than the
 * value is worth.
 */
export function TourMount() {
  const pathname = usePathname();
  const orgSlug = (pathname || "/").split("/")[1] || "";
  if (!orgSlug) return null;
  return <TourCard orgSlug={orgSlug} />;
}
