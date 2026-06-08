"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Calendar, Video } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";
import type { SyncMeeting } from "@/types/models";
import { MeetingDetail } from "@/components/meetings/meeting-detail";

interface MeetingsPanelProps {
  orgId: string;
  orgSlug: string;
}

const TYPE_LABEL: Record<SyncMeeting["meetingType"], string> = {
  STANDUP: "Standup",
  SPRINT_PLANNING: "Sprint Planning",
  SPRINT_REVIEW: "Sprint Review",
  RETROSPECTIVE: "Retrospective",
  OTHER: "Other",
};

const STATUS_LABEL: Record<SyncMeeting["status"], string> = {
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "In Progress",
  MEETING_COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/**
 * Meetings as a DOCKED-DRAWER PANEL (body only — the DockedDrawer frame
 * supplies the tool tabs, resize, and close). Self-contained master/detail: a
 * compact list of the org's meetings, then the full MeetingDetail editor for
 * the selected one. Selection is LOCAL state (no page navigation), so you can
 * take meeting notes while a kanban board stays visible behind the drawer.
 */
export function MeetingsPanel({ orgId }: MeetingsPanelProps) {
  const [meetings, setMeetings] = useState<SyncMeeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/meetings`);
      if (!res.ok) throw new Error("Failed to load meetings");
      const data = await res.json();
      setMeetings(Array.isArray(data) ? data : (data.meetings ?? []));
    } catch (err) {
      notifyError(err, "Couldn't load meetings.");
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  // Load once on mount (the panel mounts only while the Meetings tool is
  // active). load() sets loading state synchronously — the established pattern.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Detail: the selected meeting's full editor ──
  if (selectedId) {
    const selected = meetings.find((m) => m.id === selectedId);
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-10 shrink-0 items-center border-b border-[var(--border)] px-3">
          <button
            type="button"
            onClick={() => {
              setSelectedId(null);
              // Pick up any edits made in the detail view.
              void load();
            }}
            aria-label="Back to meetings"
            className="flex items-center gap-1.5 rounded p-1 text-sm font-semibold text-[var(--text)] hover:bg-[var(--primary-tint)]"
          >
            <ArrowLeft className="h-4 w-4 text-[var(--text-muted)]" />
            {selected?.title || "Meeting"}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MeetingDetail orgId={orgId} meetingId={selectedId} />
        </div>
      </div>
    );
  }

  // ── Master: the meetings list ──
  const sorted = [...meetings].sort(
    (a, b) =>
      new Date(b.meetingDate).getTime() - new Date(a.meetingDate).getTime(),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-[var(--border)] px-3">
        <span className="flex items-center gap-2 text-xs font-medium text-[var(--text-muted)]">
          <Video className="h-4 w-4 text-[var(--primary)]" />
          Meetings
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loadError ? (
          <LoadError onRetry={() => void load()} />
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        ) : meetings.length === 0 ? (
          <EmptyState
            illustration={<Video className="size-10" />}
            title="No meetings yet"
            description="Scheduled meetings show up here — open the Meetings page to schedule one."
          />
        ) : (
          <ul className="space-y-2">
            {sorted.map((m) => {
              const date = new Date(m.meetingDate);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(m.id)}
                    className={cn(
                      "flex w-full flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition-colors",
                      "hover:border-[var(--primary)]/50",
                    )}
                  >
                    <span className="truncate text-sm font-medium text-[var(--text)]">
                      {m.title || TYPE_LABEL[m.meetingType]}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                      <span className="rounded-full bg-[var(--primary-tint)] px-2 py-0.5 font-medium text-[var(--primary)]">
                        {TYPE_LABEL[m.meetingType]}
                      </span>
                      <span className="rounded-full border border-[var(--border)] px-2 py-0.5">
                        {STATUS_LABEL[m.status]}
                      </span>
                    </div>
                    <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                      <Calendar className="size-3" />
                      {date.toLocaleDateString("en-US", {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                      {" at "}
                      {date.toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
