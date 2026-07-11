"use client";
// Compact Foreman status strip for the org dashboard. Self-fetches (no
// Suspense wrapper — it renders null while loading) and stays silent for
// orgs that have never touched autonomous delivery. Links through to the
// full console (foreman-console.tsx) for detail + controls.

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import type { ForemanStatusPayload } from "@/lib/foreman/status-read";
import type { Pulse } from "@/lib/foreman/observe";
import { cn } from "@/lib/utils";
import { Bot } from "lucide-react";
import { rel } from "./foreman-console";

const PULSE_DOT_CLASSES: Record<Pulse, string> = {
  alive: "bg-emerald-500",
  idle: "bg-emerald-500",
  stale: "bg-red-500",
  paused: "bg-[var(--text-muted)]",
  breaker: "bg-amber-500",
};

// The events route returns full foreman_events rows — only typing what the
// card reads (see foreman-event-feed.tsx's ForemanEventRow for precedent).
interface ShippedEventsPage {
  events: { ts: string; data: { version?: string } | null }[];
}

export function ForemanPulseCard({ orgId }: { orgId: string }) {
  const { orgSlug } = useParams<{ orgSlug: string }>();

  const { data, isLoading, isError } = useQuery({
    queryKey: useOrgQueryKey("foreman-pulse"),
    queryFn: () => jsonFetch<ForemanStatusPayload>(`/api/v1/orgs/${orgId}/foreman/status`),
    refetchInterval: 60_000,
  });

  // Whether the card has anything to show at all — mirrors the render-null
  // condition below. Gates the second query so orgs that will never render
  // this card don't also fire a second, pointless request every 60s.
  const shouldShow = !!data && (data.config.autonomousDelivery.enabled || data.hasHistory);

  const { data: shipped } = useQuery({
    queryKey: useOrgQueryKey("foreman-pulse-shipped"),
    queryFn: () =>
      jsonFetch<ShippedEventsPage>(`/api/v1/orgs/${orgId}/foreman/events?kind=shipped&limit=1`),
    refetchInterval: 60_000,
    enabled: shouldShow,
  });

  if (isLoading || isError || !data || !shouldShow) return null;

  // `state` is null until the daemon's first-ever heartbeat — same fallback
  // as the console (see rel()'s neighbor in foreman-console.tsx).
  const pulse: Pulse = data.state?.pulse ?? (data.paused ? "paused" : "stale");

  const lastShipped = shipped?.events[0];
  const shippedFragment =
    lastShipped?.data?.version != null
      ? ` · shipped v${lastShipped.data.version} ${rel(lastShipped.ts)}`
      : "";

  return (
    <Link
      href={`/${orgSlug}/foreman`}
      className="mb-8 flex items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-sm transition-shadow hover:shadow-[var(--shadow-glow)]"
    >
      <Bot className="h-4 w-4 shrink-0 text-[var(--primary)]" aria-hidden />
      <span
        data-pulse={pulse}
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", PULSE_DOT_CLASSES[pulse])}
      />
      <span className="text-[var(--text-muted)]">
        {data.inFlight.length} building · {data.awaitingApproval.length} awaiting approval
        {shippedFragment}
      </span>
    </Link>
  );
}
