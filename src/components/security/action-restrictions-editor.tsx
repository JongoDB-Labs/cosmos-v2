"use client";

import { Button } from "@/components/ui/button";
import { PERMISSION_GROUPS, labelOf } from "@/lib/rbac/permission-groups";
import { Plus, Trash2 } from "lucide-react";

// An org-wide restriction: a DENY of some actions for everyone in the org
// (except the owner's own session) and for every API key. Saved with the rest
// of the security settings, and checked strictly by the server
// (lib/security/action-restrictions.ts). This editor writes the three common
// shapes; a rule with attribute conditions, written through the API, is shown
// and kept exactly as it is.
export type RestrictionCondition = { rel: string } | { attr: string; op: string; value: unknown };
export interface Restriction {
  id?: string;
  effect: "deny";
  actions: string[];
  conditions: RestrictionCondition[];
}
type Mode = "always" | "owns_resource" | "in_project" | "custom";

function modeOf(r: Restriction): Mode {
  if (r.conditions.length === 0) return "always";
  if (r.conditions.length === 1 && "rel" in r.conditions[0]) {
    const rel = r.conditions[0].rel;
    if (rel === "owns_resource" || rel === "in_project") return rel;
  }
  return "custom";
}

const MODE_TEXT: Record<Exclude<Mode, "custom">, string> = {
  always: "Everywhere: the permission itself is taken away",
  owns_resource: "Only on things the person owns, created or is assigned",
  in_project: "Only in projects the person is a member of",
};

export function ActionRestrictionsEditor({
  value,
  onChange,
}: {
  value: Restriction[];
  onChange: (next: Restriction[]) => void;
}) {
  const update = (i: number, next: Restriction) => onChange(value.map((r, idx) => (idx === i ? next : r)));

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Each restriction takes the actions you tick away from everyone in this organization, and from every API key,
        even where their role would allow them. The owner&apos;s own sign-in is never restricted, so a mistake can
        always be undone.
      </p>
      {value.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">No restrictions.</p>
      ) : (
        <ol className="space-y-2">
          {value.map((r, i) => {
            const mode = modeOf(r);
            const n = i + 1;
            return (
              <li key={i} className="space-y-2 rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-medium">
                    Restriction {n}: {r.actions.length} action{r.actions.length === 1 ? "" : "s"}
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove restriction ${n}`}
                    onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {mode === "custom" ? (
                  <p className="text-xs text-muted-foreground">
                    This restriction has attribute conditions set through the API. They are kept as they are.
                  </p>
                ) : (
                  <label className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Applies:</span>
                    <select
                      className="rounded border bg-background px-2 py-1 text-xs"
                      value={mode}
                      onChange={(e) => {
                        const m = e.target.value as Exclude<Mode, "custom">;
                        update(i, { ...r, conditions: m === "always" ? [] : [{ rel: m }] });
                      }}
                    >
                      {(Object.keys(MODE_TEXT) as Exclude<Mode, "custom">[]).map((m) => (
                        <option key={m} value={m}>
                          {MODE_TEXT[m]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <fieldset className="max-h-48 space-y-2 overflow-y-auto rounded border p-2">
                  <legend className="sr-only">Actions restricted by restriction {n}</legend>
                  {Object.entries(PERMISSION_GROUPS).map(([group, keys]) => (
                    <div key={group}>
                      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{group}</p>
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        {keys.map((k) => (
                          <label key={k} className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              className="size-3.5 rounded border-border"
                              checked={r.actions.includes(k)}
                              onChange={() =>
                                update(i, {
                                  ...r,
                                  actions: r.actions.includes(k) ? r.actions.filter((a) => a !== k) : [...r.actions, k],
                                })
                              }
                            />
                            {group} · {labelOf(k)}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </fieldset>
              </li>
            );
          })}
        </ol>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => onChange([...value, { effect: "deny", actions: [], conditions: [] }])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" /> Add restriction
      </Button>
    </div>
  );
}

/** A restriction with nothing ticked can't be saved; say which. */
export function emptyRestriction(value: Restriction[]): number | null {
  const i = value.findIndex((r) => r.actions.length === 0);
  return i === -1 ? null : i;
}
