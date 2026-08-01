"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { TimePerson } from "@/lib/time/scope";
import { byDateOnlyDesc, dateOnlyKey } from "@/lib/time/date-only";
import { formatDateStable } from "@/lib/format/stable-date";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import type { ColumnDef } from "@tanstack/react-table";
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
  Clock,
  List,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Send,
  Pencil,
  Trash2,
  Filter,
} from "lucide-react";
import type { ActionMenuGroup } from "@/components/ui/action-menu";
import type { TimeEntry } from "@/types/models";
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";

interface Project {
  id: string;
  name: string;
  key: string;
}

interface Clin {
  id: string;
  code: string;
  title: string;
}

interface TimeTrackerProps {
  orgId: string;
}

type ViewMode = "week" | "list";

type Timesheet = {
  id: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  status: "OPEN" | "SUBMITTED" | "LABOR_APPROVED" | "APPROVED" | "REJECTED" | "LOCKED";
  rejectedReason: string | null;
  /** Everyone the week was routed to at submit time. Empty = nobody could. */
  approverIds: string[];
  approverNames: string[];
};

/**
 * "Waiting on whom?" — the question a status badge alone cannot answer.
 *
 * Names people rather than counting them wherever it fits: "2 approvers" tells a
 * worker nothing they can act on, and chasing an approval is the main reason
 * they come back to this page.
 */
function waitingOnLabel(names: string[]): string {
  if (names.length === 0) return "Waiting on an approver";
  if (names.length <= 2) return `Waiting on ${names.join(" and ")}`;
  return `Waiting on ${names[0]} and ${names.length - 1} others`;
}

/** Where a submission went, or would go — see lib/time/routing.ts. */
type RoutedTo = {
  reason: "manager" | "admin_pool" | "none";
  approverNames: string[];
};

/**
 * What the Submit button promises before it is pressed.
 *
 * The `none` case is the one that matters: without it a worker hands in a week
 * that reaches nobody and has no way to tell. Saying so on the button — and
 * disabling nothing, because the hours still need recording — lets them fix the
 * cause instead of waiting on an approval that is never coming.
 */
function submitHint(route: RoutedTo | null, noHours: boolean): string | undefined {
  if (noHours) return "Log some time first";
  if (!route) return undefined;
  if (route.reason === "none") {
    return "Nobody is set up to approve your time yet. You can still submit, but ask an admin to set your supervisor.";
  }
  if (route.approverNames.length > 0) {
    return `Goes to ${route.approverNames.join(", ")} for approval.`;
  }
  return undefined;
}

const TIMESHEET_LABELS: Record<Timesheet["status"], string> = {
  OPEN: "Open",
  SUBMITTED: "Submitted",
  LABOR_APPROVED: "Awaiting cost approval",
  APPROVED: "Approved",
  REJECTED: "Returned",
  LOCKED: "Locked",
};

/**
 * What to tell the worker after they submit.
 *
 * Each branch is a genuinely different situation, and collapsing them into one
 * cheerful "Submitted!" is what left the worker unable to answer "waiting on
 * whom?". The `none` case in particular is a problem they need to act on —
 * their hours are in limbo until somebody is given authority to approve them.
 */
function submissionMessage(routedTo: RoutedTo | undefined): string {
  if (routedTo?.reason === "manager" && routedTo.approverNames.length > 0) {
    return `Week submitted to ${routedTo.approverNames.join(", ")} for approval.`;
  }
  if (routedTo?.reason === "admin_pool") {
    return "Week submitted. Your organisation's approvers have been notified.";
  }
  if (routedTo?.reason === "none") {
    return "Week submitted, but nobody is set up to approve it yet — ask an admin to set your supervisor.";
  }
  return "Week submitted for approval.";
}

const STATUS_COLORS: Record<TimeEntry["status"], string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  SUBMITTED: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
  APPROVED: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  REJECTED: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

const BILLABLE_LABELS: Record<TimeEntry["billableType"], string> = {
  BILLABLE: "Billable",
  NON_BILLABLE: "Non-Billable",
  INTERNAL: "Internal",
};

function getWeekDates(baseDate: Date): Date[] {
  const start = new Date(baseDate);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  const dates: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    dates.push(d);
  }
  return dates;
}

function toDateString(d: Date): string {
  return d.toISOString().split("T")[0];
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface EntryFormData {
  date: string;
  hours: string;
  projectId: string;
  clinId: string;
  description: string;
  billableType: TimeEntry["billableType"];
  tags: string;
}

const emptyForm: EntryFormData = {
  date: toDateString(new Date()),
  hours: "",
  projectId: "",
  clinId: "",
  description: "",
  billableType: "BILLABLE",
  tags: "",
};

export function TimeTracker({ orgId }: TimeTrackerProps) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<ViewMode>("week");
  const [weekBase, setWeekBase] = useState<Date>(new Date());
  // Whose week the URL asked for, held until the people list arrives — setting
  // the picker to somebody it has never heard of leaves it blank.
  const [requestedUserId, setRequestedUserId] = useState<string | null>(null);
  // Where MY next submission would go. Fetched up front so the Submit button
  // can say so BEFORE it is pressed — discovering that nobody was asked only
  // after handing the week in is too late to act on.
  const [myRoute, setMyRoute] = useState<RoutedTo | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [form, setForm] = useState<EntryFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [filterBillable, setFilterBillable] = useState<string>("ALL");
  const [showFilters, setShowFilters] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [clins, setClins] = useState<Clin[]>([]);
  // Whose time is on screen. This page shows ONE person at a time on purpose:
  // getDayTotal/weekTotal below sum every row they are handed, so a response
  // mixing several people would turn "your week" into their hours added
  // together. "" means the signed-in user.
  const [people, setPeople] = useState<TimePerson[]>([]);
  const [personId, setPersonId] = useState("");
  // Viewing a colleague's time is READ-ONLY. Every write path here acts on the
  // SIGNED-IN user — POST /time-entries takes userId from the session, and the
  // API refuses edits to another person's rows — so leaving "Log Time" on
  // screen while a report's week is shown would silently file the entry
  // against the supervisor instead.
  const viewingSomeoneElse = personId !== "";

  // The pay period covering the week on screen, for the person on screen.
  // Approval is a PERIOD-level action — submitting entries one at a time
  // produces half-submitted weeks that no approver or payroll run can read.
  const [timesheet, setTimesheet] = useState<Timesheet | null>(null);
  const [actionPending, setActionPending] = useState(false);
  // "" means ME, and ME has to be sent EXPLICITLY. A TIME_READ_ALL holder who
  // sends no userId gets every entry in the org, and the week grid would sum
  // all of it into "your week" — the arithmetic bug this picker exists to fix,
  // still present in the default state. Resolved from the people list rather
  // than threaded in as a prop, so there is one source of "who am I".
  const selfUserId = people.find((p) => p.isSelf)?.userId ?? "";
  const shownUserId = personId || selfUserId;

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/time-entries/people`);
        if (!res.ok) return; // no picker beats a broken page
        const body = await res.json();
        setPeople(body.data ?? []);
      } catch {
        /* the picker is an enhancement, not a prerequisite */
      }
    })();
  }, [orgId]);

  /**
   * Open the week a notification points at: `?userId=…&week=YYYY-MM-DD`.
   *
   * Without this an approver told "Ada submitted a timesheet" lands on their
   * OWN current week and has to find Ada's by hand, which is most of the work
   * the notification was supposed to save.
   *
   * Read from `window.location` in a mount effect rather than
   * `useSearchParams()`: this component is not inside a Suspense boundary, and
   * with Cache Components on, that hook would fail the build.
   */
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const week = sp.get("week");
    const who = sp.get("userId");
    // Parsed as UTC midnight. `new Date("2026-07-27")` is already UTC, but
    // being explicit keeps it out of the class of timezone bugs that made time
    // entries render a day early west of UTC.
    if (week && /^\d{4}-\d{2}-\d{2}$/.test(week)) {
      const parsed = new Date(`${week}T00:00:00.000Z`);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!Number.isNaN(parsed.getTime())) setWeekBase(parsed);
    }
    if (who) setRequestedUserId(who);
  }, []);

  // Applied once the picker knows who that is. Self needs no selection — ""
  // already means "me" — and asking for someone unreadable is simply ignored.
  useEffect(() => {
    if (!requestedUserId || people.length === 0) return;
    const match = people.find((p) => p.userId === requestedUserId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (match) setPersonId(match.isSelf ? "" : match.userId);
    setRequestedUserId(null);
  }, [requestedUserId, people]);

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

  // Fetch CLINs for the selected project whenever projectId changes in the form.
  // (The CLIN picker is hidden without a project, so we just skip the fetch then
  // — no synchronous state-clear in the effect body.)
  useEffect(() => {
    if (!form.projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/projects/${form.projectId}/clins`);
        if (cancelled) return;
        const data = res.ok ? await res.json() : null;
        const rows: Clin[] = Array.isArray(data) ? data : (data?.data ?? []);
        if (!cancelled) setClins(rows);
      } catch {
        if (!cancelled) setClins([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, form.projectId]);

  const weekDates = getWeekDates(weekBase);
  const weekStart = toDateString(weekDates[0]);
  const weekEnd = toDateString(weekDates[6]);

  const [refreshKey, setRefreshKey] = useState(0);

  // Where MY submissions go. Refetched on refreshKey so that setting a
  // supervisor and coming back shows the new answer rather than a stale warning.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/time-entries/my-approvers`);
        if (cancelled || !res.ok) return;
        const body = await res.json();
        if (!cancelled) setMyRoute(body ?? null);
      } catch {
        /* the button simply loses its hint — never block submitting */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, refreshKey]);


  // Guards against stale responses: only the most recent load() applies state,
  // so a slow request for a previous week/filter can't clobber the current one.
  const reqRef = useRef(0);
  const load = useCallback(async () => {
    const token = ++reqRef.current;
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams();
      if (view === "week") {
        params.set("startDate", weekStart);
        params.set("endDate", weekEnd);
      }
      if (filterStatus !== "ALL") params.set("status", filterStatus);
      if (filterBillable !== "ALL") params.set("billableType", filterBillable);
      // Pin to one person so the day/week totals below describe THAT person.
      if (shownUserId) params.set("userId", shownUserId);
      const res = await fetch(`/api/v1/orgs/${orgId}/time-entries?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (reqRef.current !== token) return;
      // GET /time-entries returns `success({ data, total })` → the body is
      // `{ data: TimeEntry[], total }`. Read `.data` (raw fetch, so jsonFetch's
      // single-key unwrap doesn't apply). The Array/`.entries` fallbacks keep
      // older/alternate shapes working. (Reading `.entries` was the bug: it's
      // always undefined → the list rendered EMPTY in both week and list views.)
      setEntries(
        Array.isArray(data) ? data : (data.data ?? data.entries ?? []),
      );
    } catch {
      if (reqRef.current === token) setLoadError(true);
    } finally {
      if (reqRef.current === token) setLoading(false);
    }
  }, [orgId, view, weekStart, weekEnd, filterStatus, filterBillable, shownUserId, refreshKey]);

  // The week's timesheet, refetched whenever the week, the person, or a
  // successful action changes it. Inline IIFE + cancel flag, matching the CLIN
  // fetch above: a useCallback here trips the React Compiler's
  // "existing memoization could not be preserved".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ periodStart: weekStart });
        if (shownUserId) params.set("userId", shownUserId);
        const res = await fetch(`/api/v1/orgs/${orgId}/timesheets?${params}`);
        if (cancelled || !res.ok) return;
        const body = await res.json();
        const rows: Timesheet[] = body.data ?? [];
        if (!cancelled) setTimesheet(rows[0] ?? null);
      } catch {
        /* the week still renders without its status */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, weekStart, shownUserId, refreshKey]);

  const runTimesheetAction = async (
    action: "submit" | "withdraw" | "approve" | "reject",
    reason?: string,
  ) => {
    if (!timesheet) return;
    setActionPending(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/timesheets/${timesheet.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, reason }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "That action could not be completed.");
      }
      // "Who did this go to?" had no answer before — submitting flipped a
      // status silently. Say it out loud, at the moment they ask.
      if (action === "submit") {
        const body = await res.json().catch(() => null);
        toast.success(submissionMessage(body?.routedTo));
      }
      // Entry statuses move with the timesheet, so both have to refetch.
      setRefreshKey((k) => k + 1);
    } catch (err) {
      notifyError(err, "Couldn't update the timesheet.");
    } finally {
      setActionPending(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const body = {
        date: form.date,
        hours: parseFloat(form.hours) || 0,
        projectId: form.projectId || null,
        clinId: form.clinId || null,
        description: form.description,
        billableType: form.billableType,
        tags: form.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      };

      const url = editingEntry
        ? `/api/v1/orgs/${orgId}/time-entries/${editingEntry.id}`
        : `/api/v1/orgs/${orgId}/time-entries`;
      const method = editingEntry ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Failed to save time entry.");
      setDialogOpen(false);
      setEditingEntry(null);
      setForm(emptyForm);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't save the time entry.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/time-entries/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete time entry.");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't delete the time entry.");
    }
  };

  const openCreate = (date?: string) => {
    setEditingEntry(null);
    setForm({ ...emptyForm, date: date || toDateString(new Date()) });
    setDialogOpen(true);
  };

  const openEdit = (entry: TimeEntry) => {
    setEditingEntry(entry);
    setForm({
      date: dateOnlyKey(entry.date),
      hours: String(entry.hours),
      projectId: entry.projectId || "",
      clinId: entry.clinId || "",
      description: entry.description,
      billableType: entry.billableType,
      tags: entry.tags.join(", "),
    });
    setDialogOpen(true);
  };

  const navigateWeek = (direction: number) => {
    const next = new Date(weekBase);
    next.setDate(next.getDate() + direction * 7);
    setWeekBase(next);
  };

  const getEntriesForDate = (date: string): TimeEntry[] => {
    // Same key the list cell formats from — the two views disagreeing about
    // which day an entry falls on was the bug.
    return entries.filter((e) => dateOnlyKey(e.date) === date);
  };

  const getDayTotal = (date: string): number => {
    return getEntriesForDate(date).reduce((sum, e) => sum + e.hours, 0);
  };

  const weekTotal = weekDates.reduce((sum, d) => sum + getDayTotal(toDateString(d)), 0);

  const groupedByRow = (() => {
    const map = new Map<string, Map<string, TimeEntry[]>>();
    entries.forEach((entry) => {
      const rowKey = `${entry.projectId || "none"}|${entry.description}`;
      if (!map.has(rowKey)) map.set(rowKey, new Map());
      const dateKey = entry.date.split("T")[0];
      const dateMap = map.get(rowKey)!;
      if (!dateMap.has(dateKey)) dateMap.set(dateKey, []);
      dateMap.get(dateKey)!.push(entry);
    });
    return map;
  })();

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
        {/* Title/subtitle are owned by the page shell (PageShell). This row
            only carries the view controls + actions, which wrap on mobile so
            the "Log Time" button never clips off the right edge. */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Only worth rendering when there IS someone else to look at — a
              picker with one option is noise on everyone else's page. */}
          {people.length > 1 && (
            <select
              aria-label="Whose time to show"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
            >
              {/* Self is always "" so that picking yourself can never read as
                  "viewing someone else" and hide your own Log Time button. */}
              <option value="">My time</option>
              {people
                .filter((p) => !p.isSelf)
                .map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.displayName ?? "Teammate"}
                  </option>
                ))}
            </select>
          )}
          <div className="flex items-center rounded-lg border bg-muted/50 p-0.5">
            <button
              onClick={() => setView("week")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                view === "week"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <CalendarDays className="size-4" />
              Week
            </button>
            <button
              onClick={() => setView("list")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                view === "list"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <List className="size-4" />
              List
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowFilters(!showFilters)}>
            <Filter className="size-4" />
            Filters
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            {!viewingSomeoneElse && (
              <DialogTrigger
                render={
                  <Button onClick={() => openCreate()}>
                    <Plus className="size-4" />
                    Log Time
                  </Button>
                }
              />
            )}
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingEntry ? "Edit Time Entry" : "Log Time"}
                </DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="te-date">Date</Label>
                    <Input
                      id="te-date"
                      type="date"
                      value={form.date}
                      onChange={(e) => setForm({ ...form, date: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="te-hours">Hours</Label>
                    <Input
                      id="te-hours"
                      type="number"
                      step="0.25"
                      min="0"
                      max="24"
                      placeholder="0.00"
                      value={form.hours}
                      onChange={(e) => setForm({ ...form, hours: e.target.value })}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Project (optional)</Label>
                  <Select
                    value={form.projectId || "none"}
                    onValueChange={(val) =>
                      setForm({
                        ...form,
                        projectId: !val || val === "none" ? "" : val,
                        clinId: "",
                      })
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
                {form.projectId && (
                  <div className="flex flex-col gap-1.5">
                    <Label>CLIN (optional)</Label>
                    <Select
                      value={form.clinId || "none"}
                      onValueChange={(val) =>
                        setForm({ ...form, clinId: !val || val === "none" ? "" : val })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select a CLIN" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">— No CLIN —</SelectItem>
                        {clins.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.code} — {c.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="te-desc">Description</Label>
                  <Textarea
                    id="te-desc"
                    placeholder="What did you work on?"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Billable Type</Label>
                  <Select
                    value={form.billableType}
                    onValueChange={(val) =>
                      setForm({ ...form, billableType: val as TimeEntry["billableType"] })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BILLABLE">Billable</SelectItem>
                      <SelectItem value="NON_BILLABLE">Non-Billable</SelectItem>
                      <SelectItem value="INTERNAL">Internal</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="te-tags">Tags (comma separated)</Label>
                  <Input
                    id="te-tags"
                    placeholder="design, review, frontend"
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={saving || !form.hours}>
                  {saving ? "Saving..." : editingEntry ? "Update" : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {showFilters && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Status</Label>
            <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v ?? "ALL")}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="DRAFT">Draft</SelectItem>
                <SelectItem value="SUBMITTED">Submitted</SelectItem>
                <SelectItem value="APPROVED">Approved</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Billable</Label>
            <Select value={filterBillable} onValueChange={(v) => setFilterBillable(v ?? "ALL")}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="BILLABLE">Billable</SelectItem>
                <SelectItem value="NON_BILLABLE">Non-Billable</SelectItem>
                <SelectItem value="INTERNAL">Internal</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : loadError ? (
        <LoadError onRetry={() => { void load(); }} />
      ) : view === "week" ? (
        <WeekView
          weekDates={weekDates}
          groupedByRow={groupedByRow}
          getDayTotal={getDayTotal}
          weekTotal={weekTotal}
          onNavigate={navigateWeek}
          onCellClick={viewingSomeoneElse ? undefined : openCreate}
          onEdit={viewingSomeoneElse ? undefined : openEdit}
          timesheet={timesheet}
          isOwnTimesheet={!viewingSomeoneElse}
          actionPending={actionPending}
          onTimesheetAction={runTimesheetAction}
          myRoute={myRoute}
        />
      ) : (
        <ListView
          entries={entries}
          onEdit={viewingSomeoneElse ? undefined : openEdit}
          onDelete={viewingSomeoneElse ? undefined : handleDelete}
        />
      )}
    </div>
  );
}

function WeekView({
  weekDates,
  groupedByRow,
  getDayTotal,
  weekTotal,
  onNavigate,
  onCellClick,
  onEdit,
  timesheet,
  isOwnTimesheet,
  actionPending,
  onTimesheetAction,
  myRoute,
}: {
  weekDates: Date[];
  groupedByRow: Map<string, Map<string, TimeEntry[]>>;
  getDayTotal: (date: string) => number;
  weekTotal: number;
  onNavigate: (dir: number) => void;
  // Write handlers are OPTIONAL: absent = read-only, which is how another
  // person's week is shown. Optional rather than a `readOnly` boolean so the
  // type makes an unhandled action impossible instead of merely discouraged.
  onCellClick?: (date: string) => void;
  onEdit?: (entry: TimeEntry) => void;
  timesheet: Timesheet | null;
  isOwnTimesheet: boolean;
  actionPending: boolean;
  onTimesheetAction: (
    action: "submit" | "withdraw" | "approve" | "reject",
    reason?: string,
  ) => void;
  /** Where the SIGNED-IN user's submissions go — drives the pre-submit hint. */
  myRoute: RoutedTo | null;
}) {
  const weekLabel = `${weekDates[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${weekDates[6].toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Previous week" onClick={() => onNavigate(-1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-48 text-center text-sm font-medium">{weekLabel}</span>
          <Button variant="outline" size="icon" aria-label="Next week" onClick={() => onNavigate(1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {timesheet && (
            <Badge
              variant={
                timesheet.status === "APPROVED"
                  ? "done"
                  : timesheet.status === "REJECTED"
                    ? "blocked"
                    : "review"
              }
            >
              {TIMESHEET_LABELS[timesheet.status]}
            </Badge>
          )}

          {/* The badge alone says a week was handed over but not to whom, which
              is exactly the question a worker asks after submitting. Shown
              beside it rather than inside it so the badge text stays a plain
              status. */}
          {timesheet &&
            (timesheet.status === "SUBMITTED" ||
              timesheet.status === "LABOR_APPROVED") && (
              <span
                className="text-muted-foreground"
                title={
                  timesheet.approverNames.length > 0
                    ? `Routed to ${timesheet.approverNames.join(", ")} when this week was submitted.`
                    : "This week was submitted without a supervisor set, so nobody was asked to approve it."
                }
              >
                {waitingOnLabel(timesheet.approverNames)}
              </span>
            )}

          {/* Submitting is the WORKER's action on their OWN week. */}
          {timesheet && isOwnTimesheet &&
            (timesheet.status === "OPEN" || timesheet.status === "REJECTED") && (
              <Button
                size="sm"
                disabled={actionPending || weekTotal === 0}
                // Nothing to submit is a real state, and a button that errors
                // on an empty week teaches people to distrust it. Beyond that,
                // the hint names who the week is about to go to — or warns that
                // it would reach nobody.
                title={submitHint(myRoute, weekTotal === 0)}
                onClick={() => onTimesheetAction("submit")}
              >
                <Send className="size-4" />
                Submit week
              </Button>
            )}

          {/* Taking your OWN submission back. Without this the only route is to
              ask an approver to Return it, which stamps a rejection reason and
              reads as "your supervisor bounced this" rather than "I withdrew
              it". Gone once an approver has signed — see withdrawTransition. */}
          {timesheet && isOwnTimesheet && timesheet.status === "SUBMITTED" && (
            <Button
              variant="outline"
              size="sm"
              disabled={actionPending}
              onClick={() => onTimesheetAction("withdraw")}
            >
              Withdraw
            </Button>
          )}

          {/* Approving is the SUPERVISOR's action on someone else's week. The
              server is authoritative about who may — this only decides what is
              worth rendering. */}
          {timesheet && !isOwnTimesheet &&
            (timesheet.status === "SUBMITTED" ||
              timesheet.status === "LABOR_APPROVED") && (
              <>
                <Button
                  size="sm"
                  disabled={actionPending}
                  onClick={() => onTimesheetAction("approve")}
                >
                  Approve week
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionPending}
                  onClick={() => {
                    // A rejection the worker cannot act on is a dead end, so a
                    // reason is required rather than optional.
                    const reason = window.prompt(
                      "Why is this week being returned?",
                    );
                    if (reason?.trim()) onTimesheetAction("reject", reason.trim());
                  }}
                >
                  Return
                </Button>
              </>
            )}

          <Clock className="size-4 text-muted-foreground" />
          <span className="font-medium">{weekTotal.toFixed(2)}h total</span>
        </div>
      </div>

      {/* Nobody can approve this person's time. Shown standing, not just as a
          tooltip: a hover hint is invisible to someone who never hovers, and
          the consequence here is hours that reach no approver at all. Limited
          to your OWN week — it is your problem to escalate, not a note about a
          colleague. */}
      {isOwnTimesheet &&
        myRoute?.reason === "none" &&
        timesheet?.status !== "APPROVED" && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <span className="font-medium">No approver set up.</span> Your
            employee record has no supervisor, and nobody else in this
            organisation can approve time. You can still submit, but the week
            will sit unapproved until an admin sets one.
          </div>
        )}

      {/* Why it came back, shown to whoever is looking at the week. */}
      {timesheet?.status === "REJECTED" && timesheet.rejectedReason && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          <span className="font-medium">Returned:</span> {timesheet.rejectedReason}
        </div>
      )}

      <div className="overflow-x-auto scrollbar-x rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                Description
              </th>
              {weekDates.map((d, i) => {
                const ds = toDateString(d);
                const isToday = ds === toDateString(new Date());
                return (
                  <th
                    key={ds}
                    className={`min-w-20 px-3 py-2 text-center font-medium ${
                      isToday ? "bg-primary/5 text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    <div>{DAY_LABELS[i]}</div>
                    <div className="text-xs font-normal">
                      {d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </div>
                  </th>
                );
              })}
              <th className="px-3 py-2 text-center font-medium text-muted-foreground">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {groupedByRow.size === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-3 py-12 text-center text-muted-foreground"
                >
                  No time entries this week. Click a cell to log time.
                </td>
              </tr>
            ) : (
              Array.from(groupedByRow.entries()).map(([rowKey, dateMap]) => {
                const desc = rowKey.split("|")[1] || "No description";
                let rowTotal = 0;
                return (
                  <tr key={rowKey} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="max-w-48 truncate px-3 py-2 font-medium">
                      {desc}
                    </td>
                    {weekDates.map((d) => {
                      const ds = toDateString(d);
                      const cellEntries = dateMap.get(ds) || [];
                      const cellTotal = cellEntries.reduce(
                        (s, e) => s + e.hours,
                        0
                      );
                      rowTotal += cellTotal;
                      const isToday = ds === toDateString(new Date());
                      return (
                        <td
                          key={ds}
                          className={`group relative min-w-20 px-3 py-2 text-center ${
                            isToday ? "bg-primary/5" : ""
                          }`}
                        >
                          {cellEntries.length > 0 ? (
                            <div className="flex flex-col items-center gap-1">
                              <span className="font-medium">{cellTotal.toFixed(2)}</span>
                              <div className="hidden gap-0.5 group-hover:flex">
                                {cellEntries.map((entry) => (
                                  <div key={entry.id} className="flex gap-0.5">
                                    {entry.status === "DRAFT" && onEdit && (
                                      <button
                                        onClick={() => onEdit(entry)}
                                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                      >
                                        <Pencil className="size-3" />
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : onCellClick ? (
                            <button
                              onClick={() => onCellClick(ds)}
                              aria-label={`Add time entry for ${ds}`}
                              className="flex size-full items-center justify-center rounded p-2 text-muted-foreground/30 hover:bg-muted hover:text-muted-foreground"
                            >
                              <Plus className="size-4" />
                            </button>
                          ) : (
                            // Read-only (viewing someone else): no add affordance.
                            <span className="block size-full" />
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center font-semibold">
                      {rowTotal.toFixed(2)}
                    </td>
                  </tr>
                );
              })
            )}
            <tr className="border-t-2 bg-muted/50 font-semibold">
              <td className="px-3 py-2">Daily Totals</td>
              {weekDates.map((d) => {
                const ds = toDateString(d);
                const total = getDayTotal(ds);
                const isToday = ds === toDateString(new Date());
                return (
                  <td
                    key={ds}
                    className={`px-3 py-2 text-center ${isToday ? "bg-primary/5 text-foreground" : ""}`}
                  >
                    {total > 0 ? total.toFixed(2) : "-"}
                  </td>
                );
              })}
              <td className="px-3 py-2 text-center">{weekTotal.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ListView({
  entries,
  onEdit,
  onDelete,
}: {
  entries: TimeEntry[];
  // Optional = read-only; see WeekView above.
  onEdit?: (entry: TimeEntry) => void;
  onDelete?: (id: string) => void;
}) {
  const sorted = [...entries].sort(byDateOnlyDesc);

  // Surface the same row operations available in the inline actions column
  // (edit / submit / delete) via right-click + the trailing ⋯ menu. Gated on
  // the SAME `status === "DRAFT"` condition the inline buttons use, so the menu
  // is empty for submitted/approved/rejected entries.
  const rowActions = useCallback(
    (entry: TimeEntry): ActionMenuGroup[] => {
      if (entry.status !== "DRAFT") return [];
      // Read-only (another person's time): no context menu either. The inline
      // buttons below are hidden on the same condition, so the two cannot
      // disagree about what is possible.
      if (!onEdit || !onDelete) return [];
      return [
        {
          items: [
            { label: "Edit", icon: Pencil, onClick: () => onEdit(entry) },
          ],
        },
        {
          items: [
            {
              label: "Delete",
              icon: Trash2,
              variant: "destructive",
              onClick: () => onDelete(entry.id),
            },
          ],
        },
      ];
    },
    [onEdit, onDelete],
  );

  const columns: ColumnDef<TimeEntry>[] = [
    {
      accessorKey: "date",
      header: "Date",
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {/* NOT `new Date(...).toLocaleDateString()` — `date` is a Postgres
              DATE serialised at UTC midnight, so that converts it into the
              viewer's zone and shows the previous day west of UTC. This row
              read 7/19 while the week grid drew the same entry on Jul 20.
              `formatDateStable` reads it in UTC, so it agrees with the
              `dateOnlyKey` the grid buckets on, and renders the same text on
              the server as in the browser. */}
          {formatDateStable(row.original.date)}
        </span>
      ),
    },
    {
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="block max-w-64 truncate">{row.original.description}</span>
      ),
    },
    {
      accessorKey: "hours",
      header: "Hours",
      cell: ({ row }) => (
        <span className="font-medium md:text-right md:block">
          {row.original.hours.toFixed(2)}
        </span>
      ),
    },
    {
      accessorKey: "billableType",
      header: "Billable",
      cell: ({ row }) => (
        <Badge variant="neutral" className="text-xs">
          {BILLABLE_LABELS[row.original.billableType]}
        </Badge>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[row.original.status]}`}
        >
          {row.original.status}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => {
        const entry = row.original;
        return (
          <div className="flex items-center justify-end gap-1">
            {entry.status === "DRAFT" && onEdit && onDelete && (
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onEdit(entry)}
                >
                  <Pencil className="size-3" />
                </Button>
                <Button
                  variant="destructive"
                  size="icon-xs"
                  onClick={() => onDelete(entry.id)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={sorted}
      rowActions={rowActions}
      emptyState={<EmptyState title="No time entries found." />}
    />
  );
}
