"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { MeetingsList } from "@/components/meetings/meetings-list";
import { MeetingDetail } from "@/components/meetings/meeting-detail";

interface MeetingsPanelProps {
  orgId: string;
  orgSlug: string;
}

/**
 * Meetings drawer tool. Master/detail: the SAME full `MeetingsList` as the
 * /meetings page (type/status filters + the Schedule-Meeting dialog + grouped
 * Today/This-Week/Past cards) wired with `onOpenMeeting` so opening a meeting
 * shows its detail IN PLACE, then the full `MeetingDetail` editor (agenda,
 * attendees, action items, AI summary). The DockedDrawer frame supplies the
 * tool tabs, resize, and close.
 */
export function MeetingsPanel({ orgId }: MeetingsPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bump to force the list to remount (re-fetch) after returning from a detail
  // view that may have edited a meeting.
  const [listKey, setListKey] = useState(0);

  if (selectedId) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-10 shrink-0 items-center border-b border-[var(--border)] px-3">
          <button
            type="button"
            onClick={() => {
              setSelectedId(null);
              setListKey((k) => k + 1);
            }}
            aria-label="Back to meetings"
            className="flex items-center gap-1.5 rounded p-1 text-sm font-semibold text-[var(--text)] hover:bg-[var(--primary-tint)]"
          >
            <ArrowLeft className="h-4 w-4 text-[var(--text-muted)]" />
            Meetings
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MeetingDetail orgId={orgId} meetingId={selectedId} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <MeetingsList
        key={listKey}
        orgId={orgId}
        onOpenMeeting={setSelectedId}
      />
    </div>
  );
}
