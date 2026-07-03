"use client";

/**
 * OKR Health view (P2): the exec lens on top of the P1 check-in history.
 *   • Stoplight-over-time grid — rows = key results (grouped into swimlanes the
 *     officer picks: by objective or by owner), columns = time periods (week or
 *     month), each cell = the RAG at that point → trajectory (green→yellow→red)
 *     at a glance.
 *   • Attention panel — the vital few: what's Behind, At risk, has open Blockers,
 *     or whose confidence just dropped.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Activity, AlertTriangle, TrendingDown, TrendingUp, Ban } from "lucide-react";
import { notifyError } from "@/lib/errors/notify";
import { RAG_META } from "./key-result-checkin-dialog";
import type { Objective, OrgMember } from "@/types/models";

type Rag = "GREEN" | "YELLOW" | "RED";

interface Checkin {
  id: string;
  keyResultId: string;
  objectiveId: string;
  ownerId: string | null;
  value: number;
  confidence: number;
  rag: Rag;
  note: string | null;
  blockers: string | null;
  createdAt: string;
}

type Swimlane = "objective" | "owner";
type Granularity = "week" | "month";

function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - day);
  return x;
}
function periodKey(iso: string, g: Granularity): string {
  const d = new Date(iso);
  if (g === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const w = startOfWeek(d);
  return `${w.getFullYear()}-${String(w.getMonth() + 1).padStart(2, "0")}-${String(w.getDate()).padStart(2, "0")}`;
}
function periodLabel(key: string, g: Granularity): string {
  if (g === "month") {
    const [y, m] = key.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short", year: "2-digit" });
  }
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleString("en-US", { month: "short", day: "numeric" });
}
/** Every period key from the earliest check-in through now (inclusive), so gaps
 *  (a period with no check-in) still get a column. */
function periodRange(minIso: string, g: Granularity): string[] {
  const keys: string[] = [];
  const cur = g === "month"
    ? new Date(new Date(minIso).getFullYear(), new Date(minIso).getMonth(), 1)
    : startOfWeek(new Date(minIso));
  const end = new Date();
  let guard = 0;
  while (cur <= end && guard++ < 400) {
    keys.push(periodKey(cur.toISOString(), g));
    if (g === "month") cur.setMonth(cur.getMonth() + 1);
    else cur.setDate(cur.getDate() + 7);
  }
  return keys;
}

export function OkrHealthView({
  orgId,
  projectId,
  objectives,
}: {
  orgId: string;
  projectId: string;
  objectives: Objective[];
}) {
  const [checkins, setCheckins] = useState<Checkin[]>([]);
  const [members, setMembers] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [swimlane, setSwimlane] = useState<Swimlane>("objective");
  const [granularity, setGranularity] = useState<Granularity>("week");

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [ciRes, memRes] = await Promise.all([
          fetch(`${basePath}/key-result-checkins`),
          fetch(`/api/v1/orgs/${orgId}/members`),
        ]);
        if (!ciRes.ok) throw new Error("Failed to load check-ins");
        const ci: Checkin[] = await ciRes.json();
        const mem: OrgMember[] = memRes.ok ? await memRes.json() : [];
        if (cancelled) return;
        setCheckins(ci);
        setMembers(new Map(mem.map((m) => [m.userId, m.user?.displayName ?? "Unknown"])));
      } catch (e) {
        if (!cancelled) notifyError(e, "Couldn't load OKR health.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [basePath, orgId]);

  // Flatten KRs with their objective + owner + latest snapshot + progress.
  const krRows = useMemo(() => {
    const rows: {
      krId: string;
      title: string;
      objectiveId: string;
      objectiveTitle: string;
      ownerId: string | null;
      rag: Rag | null;
      confidence: number | null;
      progress: number;
    }[] = [];
    for (const o of objectives) {
      for (const kr of o.keyResults ?? []) {
        const frac =
          kr.targetValue === kr.startValue
            ? kr.currentValue >= kr.targetValue
              ? 1
              : 0
            : Math.max(0, Math.min(1, (kr.currentValue - kr.startValue) / (kr.targetValue - kr.startValue)));
        rows.push({
          krId: kr.id,
          title: kr.title,
          objectiveId: o.id,
          objectiveTitle: o.title,
          ownerId: kr.ownerId ?? o.ownerId ?? null,
          rag: (kr.rag as Rag | null) ?? null,
          confidence: kr.confidence,
          progress: Math.round(frac * 100),
        });
      }
    }
    return rows;
  }, [objectives]);

  const checkinsByKr = useMemo(() => {
    const map = new Map<string, Checkin[]>();
    for (const c of checkins) {
      const arr = map.get(c.keyResultId) ?? [];
      arr.push(c);
      map.set(c.keyResultId, arr);
    }
    return map; // already oldest→newest from the API
  }, [checkins]);

  const periods = useMemo(() => {
    if (checkins.length === 0) return [];
    return periodRange(checkins[0].createdAt, granularity);
  }, [checkins, granularity]);

  // RAG per (kr, period) = the latest check-in in that period.
  const cellRag = useMemo(() => {
    const map = new Map<string, Rag>();
    for (const [krId, list] of checkinsByKr) {
      for (const c of list) {
        map.set(`${krId}|${periodKey(c.createdAt, granularity)}`, c.rag); // list is ordered, last wins
      }
    }
    return map;
  }, [checkinsByKr, granularity]);

  // Group rows into swimlanes.
  const lanes = useMemo(() => {
    const groups = new Map<string, { label: string; rows: typeof krRows }>();
    for (const r of krRows) {
      const key = swimlane === "objective" ? r.objectiveId : r.ownerId ?? "__none__";
      const label =
        swimlane === "objective"
          ? r.objectiveTitle
          : r.ownerId
            ? members.get(r.ownerId) ?? "Unknown"
            : "Unassigned";
      const g = groups.get(key) ?? { label, rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [krRows, swimlane, members]);

  // Attention panel: the vital few.
  const attention = useMemo(() => {
    const behind = krRows.filter((r) => r.rag === "RED");
    const atRisk = krRows.filter((r) => r.rag === "YELLOW");
    const blockers: { krId: string; title: string; text: string }[] = [];
    const confDrops: { krId: string; title: string; from: number; to: number }[] = [];
    for (const r of krRows) {
      const list = checkinsByKr.get(r.krId);
      if (!list || list.length === 0) continue;
      const latest = list[list.length - 1];
      if (latest.blockers && latest.blockers.trim()) {
        blockers.push({ krId: r.krId, title: r.title, text: latest.blockers });
      }
      if (list.length >= 2) {
        const prev = list[list.length - 2];
        if (latest.confidence < prev.confidence) {
          confDrops.push({ krId: r.krId, title: r.title, from: prev.confidence, to: latest.confidence });
        }
      }
    }
    return { behind, atRisk, blockers, confDrops };
  }, [krRows, checkinsByKr]);

  // Momentum map: progress (x) × momentum (y). Momentum = did the latest check-in's
  // confidence hold or rise vs the prior one. Only KRs with a check-in qualify.
  const quadrants = useMemo(() => {
    const q = {
      leading: [] as typeof krRows,
      coasting: [] as typeof krRows,
      rising: [] as typeof krRows,
      atRisk: [] as typeof krRows,
    };
    for (const r of krRows) {
      const list = checkinsByKr.get(r.krId);
      if (!list || list.length === 0) continue;
      const rising =
        list.length >= 2 ? list[list.length - 1].confidence >= list[list.length - 2].confidence : true;
      const high = r.progress >= 50;
      if (high && rising) q.leading.push(r);
      else if (high && !rising) q.coasting.push(r);
      else if (!high && rising) q.rising.push(r);
      else q.atRisk.push(r);
    }
    return q;
  }, [krRows, checkinsByKr]);

  if (loading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (krRows.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Activity}
          title="No key results yet"
          description="Add objectives with key results, then check in on them — their health-over-time shows up here."
        />
      </div>
    );
  }

  const noHistory = checkins.length === 0;

  return (
    <div className="space-y-6 p-4">
      {/* controls */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-2 font-medium text-[var(--text)]">
          <Activity className="size-4 text-[var(--primary)]" /> OKR Health
        </div>
        <label className="flex items-center gap-1.5 text-[var(--text-muted)]">
          Swimlanes
          <Segmented
            value={swimlane}
            onChange={(v) => setSwimlane(v as Swimlane)}
            options={[
              { value: "objective", label: "Objective" },
              { value: "owner", label: "Owner" },
            ]}
          />
        </label>
        <label className="flex items-center gap-1.5 text-[var(--text-muted)]">
          By
          <Segmented
            value={granularity}
            onChange={(v) => setGranularity(v as Granularity)}
            options={[
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
            ]}
          />
        </label>
        <div className="ml-auto flex items-center gap-3 text-xs text-[var(--text-muted)]">
          {(Object.keys(RAG_META) as Rag[]).map((k) => (
            <span key={k} className="flex items-center gap-1">
              <span className={cn("size-2.5 rounded-full", RAG_META[k].dot)} /> {RAG_META[k].label}
            </span>
          ))}
        </div>
      </div>

      {/* attention panel */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <AttentionCard icon={AlertTriangle} tone="red" title="Behind" count={attention.behind.length}
          items={attention.behind.map((r) => ({ key: r.krId, label: r.title, sub: r.objectiveTitle }))} />
        <AttentionCard icon={AlertTriangle} tone="yellow" title="At risk" count={attention.atRisk.length}
          items={attention.atRisk.map((r) => ({ key: r.krId, label: r.title, sub: r.objectiveTitle }))} />
        <AttentionCard icon={Ban} tone="red" title="Open blockers" count={attention.blockers.length}
          items={attention.blockers.map((b) => ({ key: b.krId, label: b.title, sub: b.text }))} />
        <AttentionCard icon={TrendingDown} tone="yellow" title="Confidence dropping" count={attention.confDrops.length}
          items={attention.confDrops.map((c) => ({ key: c.krId, label: c.title, sub: `${c.from}% → ${c.to}%` }))} />
      </div>

      {/* stoplight grid */}
      {noHistory ? (
        <EmptyState
          icon={Activity}
          title="No check-ins yet"
          description="Record a check-in on a key result (the Objectives tab) — health-over-time appears here as you go."
        />
      ) : (
        <div className="overflow-auto rounded-lg border border-[var(--border)]">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-[var(--surface)]">
                <th className="sticky left-0 z-10 min-w-[240px] bg-[var(--surface)] px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Key result
                </th>
                {periods.map((p) => (
                  <th key={p} className="px-1.5 py-2 text-center text-[11px] font-medium text-[var(--text-muted)]">
                    {periodLabel(p, granularity)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lanes.map((lane) => (
                <Fragment key={lane.label}>
                  <tr className="bg-[var(--muted)]/30">
                    <td
                      colSpan={periods.length + 1}
                      className="sticky left-0 px-3 py-1.5 text-xs font-semibold text-[var(--text)]"
                    >
                      {lane.label}
                    </td>
                  </tr>
                  {lane.rows.map((r) => (
                    <tr key={r.krId} className="border-t border-[var(--border)]">
                      <td className="sticky left-0 z-10 max-w-[240px] truncate bg-[var(--bg)] px-3 py-1.5 text-[var(--text)]">
                        {r.title}
                      </td>
                      {periods.map((p) => {
                        const rag = cellRag.get(`${r.krId}|${p}`);
                        return (
                          <td key={p} className="px-1.5 py-1.5 text-center">
                            <span
                              title={rag ? RAG_META[rag].label : "no check-in"}
                              className={cn(
                                "inline-block size-3.5 rounded-full",
                                rag ? RAG_META[rag].dot : "bg-[var(--border)]/50",
                              )}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* momentum map — progress × momentum quadrants (okrstool's Momentum Map) */}
      {!noHistory && (
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--text)]">
            <TrendingUp className="size-4 text-[var(--primary)]" /> Momentum
            <span className="text-xs font-normal text-[var(--text-muted)]">
              progress × whether confidence is holding/rising
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <AttentionCard icon={TrendingUp} tone="green" title="Leading" count={quadrants.leading.length}
              items={quadrants.leading.map((r) => ({ key: r.krId, label: r.title, sub: `${r.progress}% · gaining` }))} />
            <AttentionCard icon={Activity} tone="yellow" title="Coasting" count={quadrants.coasting.length}
              items={quadrants.coasting.map((r) => ({ key: r.krId, label: r.title, sub: `${r.progress}% · slowing` }))} />
            <AttentionCard icon={TrendingUp} tone="yellow" title="Rising" count={quadrants.rising.length}
              items={quadrants.rising.map((r) => ({ key: r.krId, label: r.title, sub: `${r.progress}% · gaining` }))} />
            <AttentionCard icon={TrendingDown} tone="red" title="At risk" count={quadrants.atRisk.length}
              items={quadrants.atRisk.map((r) => ({ key: r.krId, label: r.title, sub: `${r.progress}% · not improving` }))} />
          </div>
        </div>
      )}
    </div>
  );
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-md border border-[var(--border)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-2 py-0.5 text-xs transition-colors",
            value === o.value
              ? "bg-[var(--primary)] text-white"
              : "text-[var(--text-muted)] hover:text-[var(--text)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function AttentionCard({
  icon: Icon,
  tone,
  title,
  count,
  items,
}: {
  icon: typeof Activity;
  tone: "red" | "yellow" | "green";
  title: string;
  count: number;
  items: { key: string; label: string; sub?: string }[];
}) {
  const toneCls =
    tone === "red" ? "text-red-600" : tone === "green" ? "text-green-600" : "text-yellow-600";
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]/40 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
        <Icon className={cn("size-4", toneCls)} /> {title}
        <span className="ml-auto text-xs text-[var(--text-muted)]">{count}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">Nothing here — good.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.slice(0, 6).map((it) => (
            <li key={it.key} className="text-xs">
              <p className="truncate text-[var(--text)]">{it.label}</p>
              {it.sub && <p className="truncate text-[var(--text-muted)]">{it.sub}</p>}
            </li>
          ))}
          {items.length > 6 && (
            <li className="text-xs text-[var(--text-muted)]">+{items.length - 6} more</li>
          )}
        </ul>
      )}
    </div>
  );
}
