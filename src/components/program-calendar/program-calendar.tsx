"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { CalendarToolbar, type CalendarViewMode, type SortKey, type CustomFilters } from "./calendar-toolbar";
import { MonthGrid, type CalendarEvent } from "./month-grid";
import { TimeGrid } from "./time-grid";
import { EventDialog, type EventDraft } from "./event-dialog";
import type { ChipCategory } from "./event-chip";
import { monthGridWindow, weekWindow, dayWindow, DAY_MS, utcMidnight } from "@/lib/program-calendar/time";
import { weekDays } from "@/lib/program-calendar/layout";

interface ApiEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timeZone: string;
  location: string | null;
  attendees: string;
  recurrence: string;
  customerAttending: boolean;
  description: string;
  showOnDashboard: boolean;
  deliverableId: string | null;
  category: ChipCategory;
  ownerTeam: { id: string; name: string } | null;
  ownerMember: { id: string; user: { displayName: string } } | null;
}

/** `yyyy-mm-dd` from a UTC instant — never the local getters, which would
 *  shift the date for readers west of UTC. */
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The program calendar.
 *
 * Window, filters and view live in component state and are sent to the server
 * on every fetch rather than filtering a cached "all events" list in the
 * browser. A program's history runs for years; shipping it all to filter
 * client-side is the shape that makes the first paint slow and gets worse
 * every month the program runs.
 */
export function ProgramCalendar({
  orgId,
  projectId,
  canCreate,
  owners,
  deliverables,
}: {
  orgId: string;
  projectId?: string;
  canCreate: boolean;
  owners: { key: string; label: string }[];
  deliverables: { id: string; name: string }[];
}) {
  const [view, setView] = useState<CalendarViewMode>("month");
  const [anchor, setAnchor] = useState(() => utcMidnight(new Date()));
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedOwners, setSelectedOwners] = useState<string[]>([]);
  const [sort, setSort] = useState<SortKey>("start");
  const [filters, setFilters] = useState<CustomFilters>({
    showOnDashboardOnly: false,
    customerAttending: false,
    hasDeliverable: false,
  });
  const [draft, setDraft] = useState<EventDraft | null>(null);

  const window = useMemo(() => {
    if (view === "month") return monthGridWindow(anchor);
    if (view === "week") return weekWindow(anchor);
    return dayWindow(anchor);
  }, [view, anchor]);

  const params = useMemo(() => {
    const p = new URLSearchParams({
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    });
    if (selectedCategories.length) p.set("categoryIds", selectedCategories.join(","));
    if (selectedOwners.length) p.set("ownerKeys", selectedOwners.join(","));
    if (projectId) p.set("projectId", projectId);
    if (filters.showOnDashboardOnly) p.set("showOnDashboardOnly", "true");
    if (filters.customerAttending) p.set("customerAttending", "true");
    if (filters.hasDeliverable) p.set("hasDeliverable", "true");
    return p.toString();
  }, [window, selectedCategories, selectedOwners, filters, projectId]);

  // Through useOrgQueryKey so switching org serves a different cache namespace.
  const eventsKey = useOrgQueryKey("program-events", params);
  const categoriesKey = useOrgQueryKey("event-categories", window.from.toISOString());

  const eventsQuery = useQuery({
    queryKey: eventsKey,
    queryFn: () => jsonFetch<{ data: ApiEvent[] }>(`/api/v1/orgs/${orgId}/program-events?${params}`),
  });

  const categoriesQuery = useQuery({
    queryKey: categoriesKey,
    queryFn: () =>
      jsonFetch<{ data: (ChipCategory & { count: number })[] }>(
        `/api/v1/orgs/${orgId}/event-categories?from=${window.from.toISOString()}&to=${window.to.toISOString()}`,
      ),
  });

  const categories: ChipCategory[] = categoriesQuery.data?.data ?? [];
  const categoryCounts = useMemo(
    () => Object.fromEntries((categoriesQuery.data?.data ?? []).map((c) => [c.id, c.count])),
    [categoriesQuery.data],
  );

  const events: CalendarEvent[] = useMemo(
    () =>
      (eventsQuery.data?.data ?? []).map((e) => ({
        id: e.id,
        title: e.title,
        startsAt: new Date(e.startsAt),
        endsAt: new Date(e.endsAt),
        allDay: e.allDay,
        timeZone: e.timeZone,
        category: e.category,
      })),
    [eventsQuery.data],
  );

  const ownerLanes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of eventsQuery.data?.data ?? []) {
      const key = e.ownerTeam ? `team:${e.ownerTeam.id}` : e.ownerMember ? `member:${e.ownerMember.id}` : "unassigned";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...owners, { key: "unassigned", label: "Unassigned" }].map((o) => ({
      ...o,
      count: counts.get(o.key) ?? 0,
    }));
  }, [eventsQuery.data, owners]);

  const save = useOrgMutation({
    mutationFn: async (d: EventDraft) => {
      const body = draftToBody(d);
      const url = d.id
        ? `/api/v1/orgs/${orgId}/program-events/${d.id}`
        : `/api/v1/orgs/${orgId}/program-events`;
      return jsonFetch(url, {
        method: d.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    invalidate: [["program-events"], ["event-categories"]],
  });

  const remove = useOrgMutation({
    mutationFn: async (id: string) =>
      jsonFetch(`/api/v1/orgs/${orgId}/program-events/${id}`, { method: "DELETE" }),
    invalidate: [["program-events"], ["event-categories"]],
  });

  const step = (dir: 1 | -1) => {
    setAnchor((a) => {
      if (view === "month") return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + dir, 1));
      return new Date(a.getTime() + dir * (view === "week" ? 7 : 1) * DAY_MS);
    });
  };

  const label = useMemo(() => {
    const fmt = (o: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" }).format(anchor);
    if (view === "month") return fmt({ month: "long", year: "numeric" });
    if (view === "day") return fmt({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const w = weekWindow(anchor);
    const end = new Date(w.to.getTime() - DAY_MS);
    const f = (d: Date, o: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" }).format(d);
    return `${f(w.from, { month: "short", day: "numeric" })} – ${f(end, { month: "short", day: "numeric", year: "numeric" })}`;
  }, [view, anchor]);

  const newDraftOn = (day: Date): EventDraft => ({
    title: "",
    categoryId: categories[0]?.id ?? "",
    startDate: ymd(day),
    endDate: ymd(day),
    startTime: "09:00",
    endTime: "10:00",
    allDay: true,
    timeZone: "America/New_York",
    location: "",
    ownerKey: "",
    attendees: "",
    recurrence: "NONE",
    deliverableId: "",
    customerAttending: false,
    description: "",
    showOnDashboard: false,
  });

  const openExisting = (id: string) => {
    const e = (eventsQuery.data?.data ?? []).find((x) => x.id === id);
    if (!e) return;
    const start = new Date(e.startsAt);
    const end = new Date(e.endsAt);
    // The stored end is EXCLUSIVE for an all-day event; the form shows it the
    // way the user typed it, which is inclusive.
    const shownEnd = e.allDay ? new Date(end.getTime() - DAY_MS) : end;
    const hhmm = (d: Date) =>
      new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit", minute: "2-digit", hour12: false, timeZone: e.timeZone || "UTC",
      }).format(d);
    setDraft({
      id: e.id,
      title: e.title,
      categoryId: e.category.id,
      startDate: ymd(start),
      endDate: ymd(shownEnd),
      startTime: e.allDay ? "09:00" : hhmm(start),
      endTime: e.allDay ? "10:00" : hhmm(end),
      allDay: e.allDay,
      timeZone: e.timeZone,
      location: e.location ?? "",
      ownerKey: e.ownerTeam ? `team:${e.ownerTeam.id}` : e.ownerMember ? `member:${e.ownerMember.id}` : "",
      attendees: e.attendees,
      recurrence: e.recurrence,
      deliverableId: e.deliverableId ?? "",
      customerAttending: e.customerAttending,
      description: e.description,
      showOnDashboard: e.showOnDashboard,
    });
  };

  return (
    <div className="rounded-lg border bg-card">
      <CalendarToolbar
        label={label}
        view={view}
        onView={setView}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onToday={() => setAnchor(utcMidnight(new Date()))}
        categories={categories}
        categoryCounts={categoryCounts}
        selectedCategories={selectedCategories}
        onToggleCategory={(id) =>
          setSelectedCategories((s) => {
            // Empty means "all", so the first click has to start from the full
            // list and remove one — otherwise unticking a category would read
            // as selecting only it.
            const base = s.length ? s : categories.map((c) => c.id);
            return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
          })
        }
        onAllCategories={(all) => setSelectedCategories(all ? [] : ["__none__"])}
        owners={ownerLanes}
        selectedOwners={selectedOwners}
        onToggleOwner={(k) =>
          setSelectedOwners((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]))
        }
        sort={sort}
        onSort={setSort}
        filters={filters}
        onFilters={setFilters}
        onNew={() => setDraft(newDraftOn(anchor))}
        canCreate={canCreate}
      />

      <div className="overflow-x-auto border-t">
        {view === "month" ? (
          <MonthGrid
            from={window.from}
            to={window.to}
            month={anchor.getUTCMonth()}
            events={events}
            onSelect={openExisting}
            onAddOn={canCreate ? (d) => setDraft(newDraftOn(d)) : undefined}
            onShowDay={(d) => {
              setAnchor(d);
              setView("day");
            }}
          />
        ) : (
          <TimeGrid
            days={view === "week" ? weekDays(window.from) : [window.from]}
            events={events}
            onSelect={openExisting}
          />
        )}
      </div>

      <EventDialog
        open={draft !== null}
        onOpenChange={(o) => !o && setDraft(null)}
        draft={draft}
        categories={categories}
        owners={owners}
        deliverables={deliverables}
        saving={save.isPending}
        onSave={(d) => save.mutate(d, { onSuccess: () => setDraft(null) })}
        onDelete={(id) => remove.mutate(id, { onSuccess: () => setDraft(null) })}
      />
    </div>
  );
}

/** Form values to the API body. The single place a date STRING becomes an
 *  instant, so the all-day rule is applied once. */
export function draftToBody(d: EventDraft) {
  const startsAt = d.allDay
    ? `${d.startDate}T00:00:00.000Z`
    : new Date(`${d.startDate}T${d.startTime}:00`).toISOString();
  const endsAt = d.allDay
    ? `${d.endDate}T00:00:00.000Z`
    : new Date(`${d.endDate}T${d.endTime}:00`).toISOString();
  return {
    title: d.title.trim(),
    categoryId: d.categoryId,
    startsAt,
    endsAt,
    allDay: d.allDay,
    timeZone: d.timeZone,
    location: d.location || null,
    ownerTeamId: d.ownerKey.startsWith("team:") ? d.ownerKey.slice(5) : null,
    ownerMemberId: d.ownerKey.startsWith("member:") ? d.ownerKey.slice(7) : null,
    attendees: d.attendees,
    recurrence: d.recurrence,
    deliverableId: d.deliverableId || null,
    customerAttending: d.customerAttending,
    description: d.description,
    showOnDashboard: d.showOnDashboard,
  };
}
