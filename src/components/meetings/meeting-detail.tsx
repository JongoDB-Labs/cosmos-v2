"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Calendar,
  Users,
  Play,
  CheckCircle2,
  XCircle,
  Plus,
  Save,
  Sparkles,
  Ticket,
  FileText,
  Mic,
  Target,
  Video,
  RotateCcw,
  MessageSquare,
} from "lucide-react";
import type { SyncMeeting, MeetingAttendee, OrgMember } from "@/types/models";
import { notifyError } from "@/lib/errors/notify";
import { LoadError } from "@/components/ui/load-error";

interface MeetingDetailProps {
  orgId: string;
  meetingId: string;
}

const TYPE_CONFIG: Record<
  SyncMeeting["meetingType"],
  { label: string; icon: React.ReactNode; color: string }
> = {
  STANDUP: {
    label: "Standup",
    icon: <Mic className="size-4" />,
    color: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  },
  SPRINT_PLANNING: {
    label: "Sprint Planning",
    icon: <Target className="size-4" />,
    color: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  },
  SPRINT_REVIEW: {
    label: "Sprint Review",
    icon: <Video className="size-4" />,
    color: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  },
  RETROSPECTIVE: {
    label: "Retrospective",
    icon: <RotateCcw className="size-4" />,
    color: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  },
  OTHER: {
    label: "Other",
    icon: <MessageSquare className="size-4" />,
    color: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  },
};

const STATUS_CONFIG: Record<SyncMeeting["status"], { label: string; color: string }> = {
  SCHEDULED: {
    label: "Scheduled",
    color: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  },
  IN_PROGRESS: {
    label: "In Progress",
    color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
  },
  MEETING_COMPLETED: {
    label: "Completed",
    color: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  },
  CANCELLED: {
    label: "Cancelled",
    color: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  },
};

export function MeetingDetail({ orgId, meetingId }: MeetingDetailProps) {
  const router = useRouter();
  const [meeting, setMeeting] = useState<SyncMeeting | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [attendeeUpdates, setAttendeeUpdates] = useState<
    Record<string, Partial<MeetingAttendee>>
  >({});
  const [savingAttendee, setSavingAttendee] = useState<string | null>(null);
  const [addAttendeeOpen, setAddAttendeeOpen] = useState(false);
  const [newAttendeeUserId, setNewAttendeeUserId] = useState("");
  const [addingAttendee, setAddingAttendee] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [videoUrlDraft, setVideoUrlDraft] = useState("");
  const [savingVideo, setSavingVideo] = useState(false);
  const [generatingMeet, setGeneratingMeet] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [summarizing, setSummarizing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [meetingRes, membersRes] = await Promise.all([
        fetch(`/api/v1/orgs/${orgId}/meetings/${meetingId}`),
        fetch(`/api/v1/orgs/${orgId}/members`),
      ]);
      // A 404 is "not found" (deleted/invalid meeting), not a load failure —
      // leave meeting null so the "Meeting not found / Go Back" branch renders
      // (retrying a 404 would just loop). Other non-ok = a real load error.
      if (meetingRes.status === 404) {
        setMeeting(null);
        return;
      }
      if (!meetingRes.ok) throw new Error();
      const data = await meetingRes.json();
      setMeeting(data);
      setNotes(data.notes || "");
      if (membersRes.ok) {
        const membersData = await membersRes.json();
        setMembers(
          Array.isArray(membersData) ? membersData : membersData.members || []
        );
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId, meetingId, refreshKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const updateStatus = async (status: SyncMeeting["status"]) => {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/meetings/${meetingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update meeting status");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't update the meeting status.");
    }
  };

  const saveNotes = async () => {
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/meetings/${meetingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      if (!res.ok) throw new Error("Failed to save notes");
      const data = await res.json();
      setMeeting(data);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't save the meeting notes.");
    } finally {
      setSavingNotes(false);
    }
  };

  const getAttendeeUpdate = (attendeeId: string) => {
    return attendeeUpdates[attendeeId] || {};
  };

  const setAttendeeField = (
    attendeeId: string,
    field: keyof MeetingAttendee,
    value: string
  ) => {
    setAttendeeUpdates((prev) => ({
      ...prev,
      [attendeeId]: { ...prev[attendeeId], [field]: value },
    }));
  };

  const saveAttendeeUpdate = async (attendee: MeetingAttendee) => {
    setSavingAttendee(attendee.id);
    try {
      const update = getAttendeeUpdate(attendee.id);
      const body = {
        doneSinceLast: update.doneSinceLast ?? attendee.doneSinceLast,
        workingOn: update.workingOn ?? attendee.workingOn,
        blockers: update.blockers ?? attendee.blockers,
        notes: update.notes ?? attendee.notes,
      };
      const res = await fetch(
        `/api/v1/orgs/${orgId}/meetings/${meetingId}/attendees`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attendeeId: attendee.id, ...body }),
        }
      );
      if (!res.ok) throw new Error("Failed to save attendee update");
      setAttendeeUpdates((prev) => {
        const next = { ...prev };
        delete next[attendee.id];
        return next;
      });
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't save the standup update.");
    } finally {
      setSavingAttendee(null);
    }
  };

  const addAttendee = async () => {
    setAddingAttendee(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/meetings/${meetingId}/attendees`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: newAttendeeUserId }),
        }
      );
      if (!res.ok) throw new Error("Failed to add attendee");
      setAddAttendeeOpen(false);
      setNewAttendeeUserId("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't add the attendee.");
    } finally {
      setAddingAttendee(false);
    }
  };

  const saveVideoUrl = async (url: string | null) => {
    setSavingVideo(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/meetings/${meetingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingUrl: url }),
      });
      if (!res.ok) throw new Error("Failed to save meeting link");
      setVideoUrlDraft("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't save the meeting link.");
    } finally {
      setSavingVideo(false);
    }
  };

  const generateMeet = async () => {
    setGeneratingMeet(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/meetings/${meetingId}/video/google-meet`,
        { method: "POST" }
      );
      if (res.status === 409) {
        const b = await res.json();
        notifyError(new Error(b.error), b.error);
        return;
      }
      if (!res.ok) throw new Error("Failed to generate Meet link");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't generate a Google Meet link.");
    } finally {
      setGeneratingMeet(false);
    }
  };

  const syncArtifacts = async () => {
    setSyncing(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/meetings/${meetingId}/video/sync-artifacts`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error("Failed to sync artifacts");
      const data = await res.json();
      if (data.ready === false) {
        notifyError(new Error(data.message), data.message);
        return;
      }
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't sync Meet artifacts.");
    } finally {
      setSyncing(false);
    }
  };

  const generateSummary = async () => {
    setSummarizing(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/meetings/${meetingId}/summarize`,
        { method: "POST" }
      );
      if (res.status === 400) {
        const b = await res.json();
        notifyError(new Error(b.error), b.error);
        return;
      }
      if (!res.ok) throw new Error("Failed to generate summary");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't generate the summary.");
    } finally {
      setSummarizing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-6 w-96" />
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <LoadError onRetry={() => { void load(); }} />
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12">
        <p className="text-muted-foreground">Meeting not found</p>
        <Button variant="outline" onClick={() => router.back()}>
          <ArrowLeft className="size-4" />
          Go Back
        </Button>
      </div>
    );
  }

  const typeConfig = TYPE_CONFIG[meeting.meetingType];
  const statusConfig = STATUS_CONFIG[meeting.status];
  const date = new Date(meeting.meetingDate);
  const attendees = meeting.attendees || [];

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex flex-1 flex-col gap-1">
          {meeting.title && (
            <h1 className="text-lg font-bold">{meeting.title}</h1>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${typeConfig.color}`}
            >
              {typeConfig.icon}
              {typeConfig.label}
            </span>
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusConfig.color}`}
            >
              {statusConfig.label}
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Calendar className="size-3.5" />
              {date.toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
              {" at "}
              {date.toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {meeting.meetingUrl ? (
          <>
            <a
              href={meeting.meetingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ size: "sm" }))}
            >
              <Video className="size-4" />
              Join{" "}
              {meeting.videoProvider === "GOOGLE_MEET"
                ? "Meet"
                : meeting.videoProvider === "ZOOM"
                  ? "Zoom"
                  : meeting.videoProvider === "TEAMS"
                    ? "Teams"
                    : "call"}
            </a>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => saveVideoUrl(null)}
              disabled={savingVideo}
            >
              Remove link
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <Input
              placeholder="Paste Zoom / Teams / Meet link…"
              value={videoUrlDraft}
              onChange={(e) => setVideoUrlDraft(e.target.value)}
              className="h-8 w-64"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!videoUrlDraft || savingVideo}
              onClick={() => saveVideoUrl(videoUrlDraft)}
            >
              Add link
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={generateMeet}
              disabled={generatingMeet}
            >
              <Video className="size-4" />
              {generatingMeet ? "Generating…" : "Generate Google Meet"}
            </Button>
          </div>
        )}
        {meeting.status === "SCHEDULED" && (
          <Button size="sm" onClick={() => updateStatus("IN_PROGRESS")}>
            <Play className="size-4" />
            Start Meeting
          </Button>
        )}
        {meeting.status === "IN_PROGRESS" && (
          <Button size="sm" onClick={() => updateStatus("MEETING_COMPLETED")}>
            <CheckCircle2 className="size-4" />
            Complete Meeting
          </Button>
        )}
        {(meeting.status === "SCHEDULED" || meeting.status === "IN_PROGRESS") && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => updateStatus("CANCELLED")}
          >
            <XCircle className="size-4" />
            Cancel
          </Button>
        )}
        {meeting.meetSpaceName && meeting.status === "MEETING_COMPLETED" && (
          <Button
            size="sm"
            variant="outline"
            onClick={syncArtifacts}
            disabled={syncing}
          >
            <RotateCcw className="size-4" />
            {syncing ? "Syncing…" : "Sync Meet artifacts"}
          </Button>
        )}
      </div>

      <Separator />

      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="size-5" />
            Attendees ({attendees.length})
          </h2>
          <Dialog open={addAttendeeOpen} onOpenChange={setAddAttendeeOpen}>
            <DialogTrigger
              render={
                <Button variant="outline" size="sm">
                  <Plus className="size-4" />
                  Add Attendee
                </Button>
              }
            />
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>Add Attendee</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>Member</Label>
                  {members.length > 0 ? (
                    <Select
                      value={newAttendeeUserId}
                      onValueChange={(v) => setNewAttendeeUserId(v ?? "")}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select a member" />
                      </SelectTrigger>
                      <SelectContent>
                        {members.map((m) => (
                          <SelectItem key={m.userId} value={m.userId}>
                            {m.user?.displayName || m.user?.email || m.userId}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      placeholder="User ID"
                      value={newAttendeeUserId}
                      onChange={(e) => setNewAttendeeUserId(e.target.value)}
                    />
                  )}
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddAttendeeOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={addAttendee}
                  disabled={addingAttendee || !newAttendeeUserId}
                >
                  {addingAttendee ? "Adding..." : "Add"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {attendees.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No attendees yet. Add team members to capture their updates.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {attendees.map((attendee) => {
              const update = getAttendeeUpdate(attendee.id);
              const hasChanges = Object.keys(update).length > 0;
              const memberName =
                attendee.user?.user?.displayName ||
                attendee.user?.user?.email ||
                attendee.userId;

              return (
                <div
                  key={attendee.id}
                  className="rounded-lg border bg-background p-4"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-sm font-semibold">{memberName}</span>
                    {hasChanges && (
                      <Button
                        size="xs"
                        onClick={() => saveAttendeeUpdate(attendee)}
                        disabled={savingAttendee === attendee.id}
                      >
                        <Save className="size-3" />
                        {savingAttendee === attendee.id ? "Saving..." : "Save"}
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-xs text-muted-foreground">
                        Done since last
                      </Label>
                      <Textarea
                        className="min-h-20 text-sm"
                        placeholder="What was completed..."
                        value={update.doneSinceLast ?? attendee.doneSinceLast}
                        onChange={(e) =>
                          setAttendeeField(attendee.id, "doneSinceLast", e.target.value)
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-xs text-muted-foreground">
                        Working on
                      </Label>
                      <Textarea
                        className="min-h-20 text-sm"
                        placeholder="Currently working on..."
                        value={update.workingOn ?? attendee.workingOn}
                        onChange={(e) =>
                          setAttendeeField(attendee.id, "workingOn", e.target.value)
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-xs text-muted-foreground">Blockers</Label>
                      <Textarea
                        className="min-h-20 text-sm"
                        placeholder="Any blockers..."
                        value={update.blockers ?? attendee.blockers}
                        onChange={(e) =>
                          setAttendeeField(attendee.id, "blockers", e.target.value)
                        }
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <FileText className="size-5" />
            Notes
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={saveNotes}
            disabled={savingNotes || notes === (meeting.notes || "")}
          >
            <Save className="size-4" />
            {savingNotes ? "Saving..." : "Save Notes"}
          </Button>
        </div>
        <Textarea
          className="min-h-32"
          placeholder="Meeting notes..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {(() => {
        const a = meeting.artifacts as {
          recordings?: { driveFileId: string | null }[];
          participants?: { displayName: string | null }[];
        } | null;
        if (
          !a ||
          Array.isArray(a) ||
          (!a.recordings?.length && !a.participants?.length)
        )
          return null;
        return (
          <>
            <Separator />
            <div className="flex flex-col gap-3">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Video className="size-5" />
                Meeting Artifacts
              </h2>
              {a.recordings?.length ? (
                <div className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Recordings</span>
                  {a.recordings.map((r, i) =>
                    r.driveFileId ? (
                      <a
                        key={i}
                        href={`https://drive.google.com/file/d/${r.driveFileId}/view`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        Recording {i + 1}
                      </a>
                    ) : (
                      <span key={i} className="text-muted-foreground">
                        Recording {i + 1}
                      </span>
                    )
                  )}
                </div>
              ) : null}
              {a.participants?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {a.participants.map((p, i) => (
                    <Badge key={i} variant="neutral">
                      {p.displayName ?? "Guest"}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        );
      })()}

      {meeting.aiSummary && (
        <>
          <Separator />
          <div className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Sparkles className="size-5" />
              AI Summary
            </h2>
            <div className="rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed whitespace-pre-wrap">
              {meeting.aiSummary}
            </div>
          </div>
        </>
      )}

      {!meeting.aiSummary && (
        <>
          <Separator />
          <div className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Sparkles className="size-5" />
              AI Summary
            </h2>
            <div className="flex items-center gap-3 rounded-lg border border-dashed p-4">
              <p className="flex-1 text-sm text-muted-foreground">
                Generate an AI summary from the meeting notes and attendee updates.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={generateSummary}
                disabled={summarizing}
              >
                <Sparkles className="size-4" />
                {summarizing ? "Generating…" : "Generate Summary"}
              </Button>
            </div>
          </div>
        </>
      )}

      {meeting.aiTickets && meeting.aiTickets.length > 0 && (
        <>
          <Separator />
          <div className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Ticket className="size-5" />
              AI-Generated Tickets ({meeting.aiTickets.length})
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {meeting.aiTickets.map((ticket, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border bg-background p-4"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <Ticket className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {(ticket as Record<string, string>).title || `Ticket ${idx + 1}`}
                    </span>
                  </div>
                  {(ticket as Record<string, string>).description && (
                    <p className="text-sm text-muted-foreground">
                      {(ticket as Record<string, string>).description}
                    </p>
                  )}
                  {(ticket as Record<string, string>).type && (
                    <Badge variant="neutral" className="mt-2 text-xs">
                      {(ticket as Record<string, string>).type}
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
