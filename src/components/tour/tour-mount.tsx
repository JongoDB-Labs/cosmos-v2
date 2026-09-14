"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { PluginRegistry } from "@/lib/plugins/registry";
import { useEnabledPlugins } from "@/components/plugins/plugin-slot";
import { tourById } from "@/lib/tours/registry";
import { markTourSeen } from "@/lib/tours/seen";
import { TourCard } from "./tour-card";
import { useTour } from "./tour-provider";
import { usePermissions } from "@/components/providers/permissions-provider";

/**
 * Mounts the tour card, and honours a `?tour=<id>` link.
 *
 * The link is how somebody hands a colleague a specific walkthrough — "open
 * this and click through it" — without relying on them having seen the What's
 * new notice, or on which release they happen to be on.
 *
 * The slug comes from the path rather than a prop: this mounts in the org
 * layout, a server component, and threading an awaited param into a client
 * island for a value already in the URL is more machinery than it is worth.
 */
export function TourMount() {
  const pathname = usePathname();
  const params = useSearchParams();
  const enabled = useEnabledPlugins();
  const { start } = useTour();
  const startedRef = useRef<string | null>(null);

  // Org identity from context, never a server read: this mounts in a layout
  // above every org route, and an awaited read there fails the prerender for
  // all of them.
  const { orgId } = usePermissions();
  const orgSlug = (pathname || "/").split("/")[1] || "";
  const requested = params.get("tour");

  useEffect(() => {
    if (!requested) return;
    // Once per id: the param survives the navigations the tour itself performs,
    // and restarting on every step would pin it to step one forever.
    if (startedRef.current === requested) return;
    const tour = tourById(requested, PluginRegistry.getAll(), enabled);
    if (!tour) return;
    startedRef.current = requested;
    markTourSeen(tour.id);
    start(tour, 0);
  }, [requested, enabled, start]);

  if (!orgSlug || !orgId) return null;
  return <TourCard orgId={orgId} orgSlug={orgSlug} />;
}
