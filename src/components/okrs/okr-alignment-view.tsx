"use client";

/**
 * OKR Alignment / cascade tree (P3): objectives laddered by their parent
 * (org→team→…). Each node shows progress + a rolled-up stoplight (the worst RAG
 * among the objective's own key results AND all its descendants' — so a red KR
 * three levels down still flags the top). Collapsible.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ChevronDown, ChevronRight, Network, User } from "lucide-react";
import { RAG_META } from "./key-result-checkin-dialog";
import type { Objective, OrgMember } from "@/types/models";

type Rag = "GREEN" | "YELLOW" | "RED";
const RANK: Record<Rag, number> = { GREEN: 1, YELLOW: 2, RED: 3 };

export function OkrAlignmentView({
  orgId,
  objectives,
}: {
  orgId: string;
  objectives: Objective[];
}) {
  const [members, setMembers] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/members`);
        const mem: OrgMember[] = res.ok ? await res.json() : [];
        if (!cancelled) setMembers(new Map(mem.map((m) => [m.userId, m.user?.displayName ?? "Unknown"])));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const { roots, childrenMap, objMap } = useMemo(() => {
    const objMap = new Map(objectives.map((o) => [o.id, o]));
    const childrenMap = new Map<string, Objective[]>();
    for (const o of objectives) {
      if (o.parentId && objMap.has(o.parentId)) {
        const arr = childrenMap.get(o.parentId) ?? [];
        arr.push(o);
        childrenMap.set(o.parentId, arr);
      }
    }
    // A root has no parent, or a parent outside this project's set (orphan).
    const roots = objectives.filter((o) => !o.parentId || !objMap.has(o.parentId));
    return { roots, childrenMap, objMap };
  }, [objectives]);

  // Worst RAG among an objective's KRs + all descendants' KRs.
  const rollupRag = useMemo(() => {
    const cache = new Map<string, Rag | null>();
    const compute = (id: string, seen = new Set<string>()): Rag | null => {
      if (cache.has(id)) return cache.get(id)!;
      if (seen.has(id)) return null; // cycle guard (shouldn't happen — API prevents)
      seen.add(id);
      const o = objMap.get(id);
      let worst: Rag | null = null;
      const bump = (r: Rag | null) => {
        if (r && (!worst || RANK[r] > RANK[worst])) worst = r;
      };
      for (const kr of o?.keyResults ?? []) bump((kr.rag as Rag | null) ?? null);
      for (const c of childrenMap.get(id) ?? []) bump(compute(c.id, seen));
      cache.set(id, worst);
      return worst;
    };
    const m = new Map<string, Rag | null>();
    for (const o of objectives) m.set(o.id, compute(o.id));
    return m;
  }, [objectives, objMap, childrenMap]);

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (objectives.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Network}
          title="No objectives to align"
          description="Create objectives and set a parent (in an objective's edit dialog) to see how they ladder up."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-1 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--text)]">
        <Network className="size-4 text-[var(--primary)]" /> Alignment
        <span className="text-xs font-normal text-[var(--text-muted)]">
          how objectives ladder up (set a parent in an objective&apos;s edit dialog)
        </span>
      </div>
      {roots.map((o) => (
        <AlignNode
          key={o.id}
          obj={o}
          depth={0}
          childrenMap={childrenMap}
          rollupRag={rollupRag}
          members={members}
        />
      ))}
    </div>
  );
}

function AlignNode({
  obj,
  depth,
  childrenMap,
  rollupRag,
  members,
}: {
  obj: Objective;
  depth: number;
  childrenMap: Map<string, Objective[]>;
  rollupRag: Map<string, Rag | null>;
  members: Map<string, string>;
}) {
  const [open, setOpen] = useState(true);
  const kids = childrenMap.get(obj.id) ?? [];
  const rag = rollupRag.get(obj.id) ?? null;
  const owner = obj.ownerId ? members.get(obj.ownerId) : null;

  return (
    <Fragment>
      <div
        className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)]/40 py-2 pr-3"
        style={{ marginLeft: depth * 20, paddingLeft: 8 }}
      >
        {kids.length > 0 ? (
          <button
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text)]"
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span
          title={rag ? `Rolled-up health: ${RAG_META[rag].label}` : "No check-ins yet"}
          className={cn("size-2.5 shrink-0 rounded-full", rag ? RAG_META[rag].dot : "bg-[var(--border)]")}
        />
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{obj.title}</span>
        {owner && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--text-muted)]">
            <User className="size-3" /> {owner}
          </span>
        )}
        <div className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-[var(--border)] sm:block">
          <div className="h-full rounded-full bg-[var(--primary)]" style={{ width: `${obj.progress}%` }} />
        </div>
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-[var(--text-muted)]">
          {obj.progress}%
        </span>
      </div>
      {open &&
        kids.map((k) => (
          <AlignNode
            key={k.id}
            obj={k}
            depth={depth + 1}
            childrenMap={childrenMap}
            rollupRag={rollupRag}
            members={members}
          />
        ))}
    </Fragment>
  );
}
