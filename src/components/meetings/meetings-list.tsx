"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
  Plus,
  Calendar,
  Users,
  Filter,
  Video,
  MessageSquare,
  RotateCcw,
  Target,
  Mic,
  ExternalLink,
  Pencil,
  Trash2,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { notifyError } from "@/lib/errors/notify";
import type { SyncMeeting } from "@/types/models";

interface MeetingsListProps {
  orgId: string;
}

const MEETING_TYPE_CONFIG: Record<
  SyncMeeting["meetingType"],
  { label: string; icon: React.ReactNode; color: string }
> = {
  STANDUP: {
    label: "Standup",
    icon: <Mic className="size-3.5" />,
    color: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  },
  SPRINT_PLANNING: {
    label: "Sprint Planning",
    icon: <Target className="size-3.5" />,
    color: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  },
  SPRINT_REVIEW: {
    label: "Sprint Review",
    icon: <Video className="size-3.5" />,
    color: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  },
  RETROSPECTIVE: {
    label: "Retrospective",
    icon: <RotateCcw className="size-3.5" />,
    color: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  },
  OTHER: {
    label: "Other",
    icon: <MessageSquare className="size-3.5" />,
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

interface Project {
  id: string;
  name: string;
  key: string;
}

interface MeetingFormData {
  title: string;
  meetingType: SyncMeeting["meetingType"];
  meetingDate: string;
  projectId: string;
  notes: string;
}

const emptyForm: MeetingFormData = {
  title: "",
  meetingType: "STANDUP",
  meetingDate: new Date().toISOString().slice(0, 16),
  projectId: "",
  notes: "",
};

function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function isThisWeek(date: Date): boolean {
  const now = new Date();
  const startOfWeek = new Date(now);
  const day = startOfWeek.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  startOfWeek.setDate(startOfWeek.getDate() + diff);
  startOfWeek.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);
  return date >= startOfWeek && date <= endOfWeek;
}

export function MeetingsList({ orgId }: MeetingsListProps) {
  const router = useRouter();
  const [meetings, setMeetings] = useState<SyncMeeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<MeetingFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [filterType, setFilterType] = useState<string>("ALL");
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [showFilters, setShowFilters] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/projects`);
        if (res.ok) {
          const data = await res.json();
          setProjects(Array.isArray(data) ? data : data.projects || []);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [orgId]);

  // Guards against stale responses: only the most recent load() applies state,
  // so a slow request for a previous filter can't clobber the current one.
  const reqRef = useRef(0);
  const load = useCallback(async () => {
    const token = ++reqRef.current;
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams();
      if (filterType !== "ALL") params.set("meetingType", filterType);
      if (filterStatus !== "ALL") params.set("status", filterStatus);
      const qs = params.toString() ? `?${params}` : "";
      const res = await fetch(`/api/v1/orgs/${orgId}/meetings${qs}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (reqRef.current !== token) return;
      setMeetings(Array.isArray(data) ? data : data.meetings || []);
    } catch {
      if (reqRef.current === token) setLoadError(true);
    } finally {
      if (reqRef.current === token) setLoading(false);
    }
  }, [orgId, filterType, filterStatus, refreshKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleCreate = async () => {
    setSaving(true);
    try {
      const body = {
        title: form.title,
        meetingType: form.meetingType,
        meetingDate: new Date(form.meetingDate).toISOString(),
        projectId: form.projectId || null,
        notes: form.notes,
      };
      const res = await fetch(`/api/v1/orgs/${orgId}/meetings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to create meeting");
      setDialogOpen(false);
      setForm(emptyForm);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't schedule the meeting.");
    } finally {
      setSaving(false);
    }
  };

  const grouped = (() => {
    const today: SyncMeeting[] = [];
    const thisWeek: SyncMeeting[] = [];
    const past: SyncMeeting[] = [];

    const sorted = [...meetings].sort(
      (a, b) => new Date(b.meetingDate).getTime() - new Date(a.meetingDate).getTime()
    );

    sorted.forEach((m) => {
      const date = new Date(m.meetingDate);
      if (isToday(date)) {
        today.push(m);
      } else if (isThisWeek(date)) {
        thisWeek.push(m);
      } else {
        past.push(m);
      }
    });

    return { today, thisWeek, past };
  })();

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
        {/* Title/subtitle owned by the page shell (PageShell). */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowFilters(!showFilters)}>
            <Filter className="size-4" />
            Filters
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger
              render={
                <Button>
                  <Plus className="size-4" />
                  Schedule Meeting
                </Button>
              }
            />
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Schedule Meeting</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mt-title">Title</Label>
                  <Input
                    id="mt-title"
                    placeholder="e.g. Sprint 12 Standup"
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Meeting Type</Label>
                  <Select
                    value={form.meetingType}
                    onValueChange={(val) =>
                      setForm({ ...form, meetingType: val as SyncMeeting["meetingType"] })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="STANDUP">Standup</SelectItem>
                      <SelectItem value="SPRINT_PLANNING">Sprint Planning</SelectItem>
                      <SelectItem value="SPRINT_REVIEW">Sprint Review</SelectItem>
                      <SelectItem value="RETROSPECTIVE">Retrospective</SelectItem>
                      <SelectItem value="OTHER">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mt-date">Date & Time</Label>
                  <Input
                    id="mt-date"
                    type="datetime-local"
                    value={form.meetingDate}
                    onChange={(e) => setForm({ ...form, meetingDate: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Project (optional)</Label>
                  <Select
                    value={form.projectId || "none"}
                    onValueChange={(val) =>
                      setForm({ ...form, projectId: !val || val === "none" ? "" : val })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a project" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— No project —</SelectItem>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.key} - {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mt-notes">Notes</Label>
                  <Textarea
                    id="mt-notes"
                    placeholder="Meeting agenda or notes"
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={saving || !form.title.trim()}>
                  {saving ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {showFilters && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Type</Label>
            <Select value={filterType} onValueChange={(v) => setFilterType(v ?? "ALL")}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Types</SelectItem>
                <SelectItem value="STANDUP">Standup</SelectItem>
                <SelectItem value="SPRINT_PLANNING">Sprint Planning</SelectItem>
                <SelectItem value="SPRINT_REVIEW">Sprint Review</SelectItem>
                <SelectItem value="RETROSPECTIVE">Retrospective</SelectItem>
                <SelectItem value="OTHER">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Status</Label>
            <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v ?? "ALL")}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Statuses</SelectItem>
                <SelectItem value="SCHEDULED">Scheduled</SelectItem>
                <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                <SelectItem value="MEETING_COMPLETED">Completed</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : loadError ? (
        <LoadError onRetry={() => { void load(); }} />
      ) : meetings.length === 0 ? (
        <EmptyState
          title="No meetings yet"
          description="Schedule your first meeting to capture decisions, notes, and action items."
          action={
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="size-4" />
              Schedule Meeting
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.today.length > 0 && (
            <MeetingGroup
              title="Today"
              meetings={grouped.today}
              orgId={orgId}
              onNavigate={(id) => router.push(`meetings/${id}`)}
              onDelete={(id) =>
                setMeetings((prev) => prev.filter((m) => m.id !== id))
              }
            />
          )}
          {grouped.thisWeek.length > 0 && (
            <MeetingGroup
              title="This Week"
              meetings={grouped.thisWeek}
              orgId={orgId}
              onNavigate={(id) => router.push(`meetings/${id}`)}
              onDelete={(id) =>
                setMeetings((prev) => prev.filter((m) => m.id !== id))
              }
            />
          )}
          {grouped.past.length > 0 && (
            <MeetingGroup
              title="Past"
              meetings={grouped.past}
              orgId={orgId}
              onNavigate={(id) => router.push(`meetings/${id}`)}
              onDelete={(id) =>
                setMeetings((prev) => prev.filter((m) => m.id !== id))
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

function MeetingGroup({
  title,
  meetings,
  orgId,
  onNavigate,
  onDelete,
}: {
  title: string;
  meetings: SyncMeeting[];
  orgId: string;
  onNavigate: (meetingId: string) => void;
  onDelete: (meetingId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="flex flex-col gap-2">
        {meetings.map((meeting) => (
          <MeetingCard
            key={meeting.id}
            meeting={meeting}
            orgId={orgId}
            onClick={() => onNavigate(meeting.id)}
            onDelete={() => onDelete(meeting.id)}
          />
        ))}
      </div>
    </div>
  );
}

function MeetingCard({
  meeting,
  orgId,
  onClick,
  onDelete,
}: {
  meeting: SyncMeeting;
  orgId: string;
  onClick: () => void;
  onDelete: () => void;
}) {
  const { can } = usePermissions();
  const typeConfig = MEETING_TYPE_CONFIG[meeting.meetingType];
  const statusConfig = STATUS_CONFIG[meeting.status];
  const date = new Date(meeting.meetingDate);
  const attendeeCount = meeting.attendees?.length || 0;

  const groups: ActionMenuGroup[] = [
    {
      items: [
        {
          label: "Open",
          icon: ExternalLink,
          onClick,
        },
        ...(can(Permission.MEETING_UPDATE)
          ? [
              {
                label: "Edit",
                icon: Pencil,
                onClick,
              },
            ]
          : []),
      ],
    },
    {
      items: [
        ...(can(Permission.MEETING_DELETE)
          ? [
              {
                label: "Delete",
                icon: Trash2,
                variant: "destructive" as const,
                onClick: async () => {
                  try {
                    const res = await fetch(
                      `/api/v1/orgs/${orgId}/meetings/${meeting.id}`,
                      { method: "DELETE" },
                    );
                    if (!res.ok) throw new Error("Failed to delete meeting");
                    onDelete();
                  } catch (err) {
                    console.error(err);
                    notifyError(err, "Couldn't delete the meeting.");
                  }
                },
              },
            ]
          : []),
      ],
    },
  ];

  return (
    <ActionMenu groups={groups}>
      <button
        onClick={onClick}
        className="group/action flex items-start gap-4 rounded-lg border bg-background p-4 text-left transition-colors hover:bg-muted/50"
      >
        <div className="flex flex-1 flex-col gap-2">
          {meeting.title && (
            <span className="text-sm font-semibold">{meeting.title}</span>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${typeConfig.color}`}
            >
              {typeConfig.icon}
              {typeConfig.label}
            </span>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusConfig.color}`}
            >
              {statusConfig.label}
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Calendar className="size-3.5" />
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
            {attendeeCount > 0 && (
              <span className="flex items-center gap-1">
                <Users className="size-3.5" />
                {attendeeCount} attendee{attendeeCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          {meeting.notes && (
            <p className="line-clamp-1 text-sm text-muted-foreground">{meeting.notes}</p>
          )}
        </div>
      </button>
    </ActionMenu>
  );
}
