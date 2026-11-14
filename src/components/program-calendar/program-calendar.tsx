"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { CalendarToolbar, type CalendarViewMode, type SortKey, type CustomFilters } from "./calendar-toolbar";
import { MonthGrid, VISIBLE_LANES, type CalendarEvent } from "./month-grid";
import { TimeGrid } from "./time-grid";
import { EventDialog, type EventDraft } from "./event-dialog";
import type { ChipCategory } from "./event-chip";
import { OverlayLegend, OverlayToggles, useOverlayToggles, type OverlayToggleSpec } from "./overlay-toggles";
import { monthGridWindow, weekWindow, dayWindow, DAY_MS, utcMidnight } from "@/lib/program-calendar/time";
import { weekDays } from "@/lib/program-calendar/layout";
import {
  agileItems,
  DUE_CAP,
  milestoneItems,
  OVERLAY_STYLES,
  type AgilePayload,
  type CalendarMilestone,
  type OverlayKind,
} from "@/lib/program-calendar/overlays";

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

/**
 * What turns the calendar's overlays on. Program Management passes it; the
 * project tab does not, and renders exactly as it did before overlays existed.
 */
export interface CalendarOverlays {
  /** Where this viewer's toggles are remembered (`togglesStorageKey`). */
  storageKey: string;
  /** For the links on overlay chips. */
  orgSlug: string;
  /** Already limited, by the page, to the projects the viewer may read. */
  milestones: CalendarMilestone[];
}

/** Lanes per week the Agile overlay adds, under the events' own three: room
 *  for a Program Increment, a sprint and a release. The events keep their
 *  three either way (see `eventLanes` below), so the two never crowd each other
 *  out of a week; what does not fit is "+N more", which opens the Day view,
 *  where every item on the day is drawn. */
const AGILE_EXTRA_LANES = 3;

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
  includeOrgEvents = false,
  canCreate,
  owners,
  deliverables,
  overlays,
}: {
  orgId: string;
  /** Show this project's events, and file a new event under it. */
  projectId?: string;
  /** With `projectId`, also show the org-level events (those with no project). */
  includeOrgEvents?: boolean;
  canCreate: boolean;
  owners: { key: string; label: string }[];
  deliverables: { id: string; name: string }[];
  overlays?: CalendarOverlays;
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
  const { toggles, toggle } = useOverlayToggles(overlays?.storageKey);
  // Without overlays the calendar is its events, always on.
  const eventsOn = !overlays || toggles.events;
  const agileOn = !!overlays && toggles.agile;

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
    if (projectId && includeOrgEvents) p.set("includeOrgEvents", "true");
    if (filters.showOnDashboardOnly) p.set("showOnDashboardOnly", "true");
    if (filters.customerAttending) p.set("customerAttending", "true");
    if (filters.hasDeliverable) p.set("hasDeliverable", "true");
    return p.toString();
  }, [window, selectedCategories, selectedOwners, filters, projectId, includeOrgEvents]);

  // Through useOrgQueryKey so switching org serves a different cache namespace.
  const eventsKey = useOrgQueryKey("program-events", params);
  const categoriesKey = useOrgQueryKey("event-categories", window.from.toISOString());

  const eventsQuery = useQuery({
    queryKey: eventsKey,
    // `jsonFetch<T>` returns the parsed body AS-IS and `success()` sends a
    // BARE payload — there is no `{ data }` envelope. The generic is an
    // assertion, not a check, so declaring one here type-checked cleanly and
    // rendered an empty calendar against a correct 200 response.
    queryFn: () => jsonFetch<ApiEvent[]>(`/api/v1/orgs/${orgId}/program-events?${params}`),
    enabled: eventsOn,
  });

  const categoriesQuery = useQuery({
    queryKey: categoriesKey,
    queryFn: () =>
      jsonFetch<(ChipCategory & { count: number })[]>(
        `/api/v1/orgs/${orgId}/event-categories?from=${window.from.toISOString()}&to=${window.to.toISOString()}`,
      ),
  });

  // The Agile overlay is not filtered by category or owner (those are program
  // events' fields), so its key carries only the window and the project.
  const agileParams = useMemo(() => {
    const p = new URLSearchParams({ from: window.from.toISOString(), to: window.to.toISOString() });
    if (projectId) p.set("projectId", projectId);
    return p.toString();
  }, [window, projectId]);
  const agileKey = useOrgQueryKey("program-calendar-agile", agileParams);
  const agileQuery = useQuery({
    queryKey: agileKey,
    queryFn: () => jsonFetch<AgilePayload>(`/api/v1/orgs/${orgId}/program-calendar/agile?${agileParams}`),
    enabled: agileOn,
  });

  const categories: ChipCategory[] = categoriesQuery.data ?? [];
  const categoryCounts = useMemo(
    () => Object.fromEntries((categoriesQuery.data ?? []).map((c) => [c.id, c.count])),
    [categoriesQuery.data],
  );

  // A switched-off query keeps its last data in the cache, so "off" has to be
  // applied here too, not only by not fetching.
  const programEvents: CalendarEvent[] = useMemo(
    () =>
      eventsOn
        ? (eventsQuery.data ?? []).map((e) => ({
            id: e.id,
            title: e.title,
            startsAt: new Date(e.startsAt),
            endsAt: new Date(e.endsAt),
            allDay: e.allDay,
            timeZone: e.timeZone,
            category: e.category,
          }))
        : [],
    [eventsOn, eventsQuery.data],
  );

  // Milestones arrive as the page's whole list, so they are cut to the window
  // here; the Agile rows were already cut by the server, on the same overlap.
  const milestones: CalendarEvent[] = useMemo(
    () =>
      overlays && eventsOn
        ? milestoneItems(overlays.milestones, overlays.orgSlug).filter(
            (m) => m.startsAt < window.to && m.endsAt > window.from,
          )
        : [],
    [overlays, eventsOn, window],
  );
  const agile: CalendarEvent[] = useMemo(
    () => (overlays && agileOn && agileQuery.data ? agileItems(agileQuery.data, overlays.orgSlug) : []),
    [overlays, agileOn, agileQuery.data],
  );

  const events: CalendarEvent[] = useMemo(
    () => [...programEvents, ...milestones, ...agile],
    [programEvents, milestones, agile],
  );

  const ownerLanes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of eventsQuery.data ?? []) {
      const key = e.ownerTeam ? `team:${e.ownerTeam.id}` : e.ownerMember ? `member:${e.ownerMember.id}` : "unassigned";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...owners, { key: "unassigned", label: "Unassigned" }].map((o) => ({
      ...o,
      count: counts.get(o.key) ?? 0,
    }));
  }, [eventsQuery.data, owners]);

  const toggleSpecs: OverlayToggleSpec[] = [
    {
      key: "events",
      label: "Events",
      swatchRgb: OVERLAY_STYLES.milestone.tintRgb,
      count: eventsOn && eventsQuery.data ? eventsQuery.data.length + milestones.length : null,
      loading: eventsOn && eventsQuery.isFetching,
    },
    {
      key: "agile",
      label: "Agile",
      swatchRgb: OVERLAY_STYLES.sprint.tintRgb,
      count: agileOn && agileQuery.data ? agile.length : null,
      loading: agileOn && agileQuery.isFetching,
    },
  ];

  const legendKinds: OverlayKind[] = [
    ...(overlays && eventsOn ? (["milestone"] as const) : []),
    ...(agileOn ? (["increment", "sprint", "release", "due"] as const) : []),
  ];

  // Anything the viewer is NOT being shown, said in words. A failed overlay
  // must never look like an empty one.
  const notes: string[] = [];
  if (overlays) {
    if (eventsOn && eventsQuery.isError) notes.push(`Program events could not be loaded: ${eventsQuery.error.message}`);
    if (agileOn && agileQuery.isError) notes.push(`The Agile overlay could not be loaded: ${agileQuery.error.message}`);
    if (agileOn && agileQuery.data?.dueCapped) {
      notes.push(
        `Only the first ${DUE_CAP} work items due in this period are shown. Pick a project above to see the rest.`,
      );
    }
    if (!toggles.events && !toggles.agile) notes.push("Every overlay is off. Turn one on to fill the calendar.");
  }

  const visibleLanes = agileOn ? VISIBLE_LANES + AGILE_EXTRA_LANES : VISIBLE_LANES;

  const save = useOrgMutation({
    mutationFn: async (d: EventDraft) => {
      // A NEW event goes under the picked project, so it stays in the view it
      // was made in. An edit leaves the event's project as it is: with org
      // events shown, an org-level event edited here must not move.
      const body = draftToBody(d, d.id ? undefined : projectId);
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
    const e = (eventsQuery.data ?? []).find((x) => x.id === id);
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
        overlays={
          overlays ? <OverlayToggles specs={toggleSpecs} toggles={toggles} onToggle={toggle} /> : undefined
        }
        eventFiltersOff={!eventsOn}
      />

      <div className="overflow-x-auto border-t">
        {view === "month" ? (
          <MonthGrid
            from={window.from}
            to={window.to}
            month={anchor.getUTCMonth()}
            events={events}
            visibleLanes={visibleLanes}
            eventLanes={overlays ? VISIBLE_LANES : undefined}
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

      {overlays ? <OverlayLegend kinds={legendKinds} notes={notes} /> : null}

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
 *  instant, so the all-day rule is applied once. `projectId` is sent only when
 *  given; leaving it out of an edit keeps the event's project unchanged. */
export function draftToBody(d: EventDraft, projectId?: string) {
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
    ...(projectId ? { projectId } : {}),
  };
}
