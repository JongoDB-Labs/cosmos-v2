"use client";

import { SlidersHorizontal } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { cellState, isPlainTransition, setGlobal, setMove } from "@/lib/workflow/draft-edit";
import type { WorkflowDefinition } from "@/lib/workflow/definition";
import { cn } from "@/lib/utils";

interface StatusLabel {
  key: string;
  name: string;
  color: string;
}

/**
 * The transition matrix: rows are where an item is, columns where it may go.
 * A checkbox per cell allows the plain move; a cell whose move has rules (or a
 * name of its own) also gets a button to open its transition. The first row,
 * "Any status", is the global move into each column.
 *
 * The editor's primary view, and its accessible one: a native table of
 * labelled checkboxes, navigable by keyboard, that stays readable at 15+
 * statuses where a canvas does not.
 */
export function TransitionMatrix({
  definition,
  statuses,
  onChange,
  onEditTransition,
  readOnly = false,
}: {
  definition: WorkflowDefinition;
  /** The workflow's statuses, in display order, with their names. */
  statuses: StatusLabel[];
  onChange: (next: WorkflowDefinition) => void;
  onEditTransition: (id: string) => void;
  readOnly?: boolean;
}) {
  const nameOf = (key: string) => statuses.find((s) => s.key === key)?.name ?? key;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-sm" aria-label="Allowed moves: rows are where an item is, columns where it can go">
        <thead>
          <tr className="bg-muted/40">
            <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">
              From \ To
            </th>
            {statuses.map((to) => (
              <th key={to.key} scope="col" className="px-3 py-2 text-left font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: to.color }} />
                  {to.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-t">
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted-foreground">
              Any status
            </th>
            {statuses.map((to) => {
              const global = definition.transitions.find((t) => t.to === to.key && t.from === "*");
              return (
                <td key={to.key} className="px-3 py-2">
                  <span className="inline-flex items-center gap-1">
                    <Checkbox
                      aria-label={`Allow a move into ${to.name} from any status`}
                      checked={!!global}
                      disabled={readOnly}
                      onChange={(e) => onChange(setGlobal(definition, to.key, e.target.checked, nameOf))}
                    />
                    {global && <EditButton name={global.name} ruled={!isPlainTransition(global)} onClick={() => onEditTransition(global.id)} />}
                  </span>
                </td>
              );
            })}
          </tr>
          {statuses.map((from) => (
            <tr key={from.key} className="border-t">
              <th scope="row" className="px-3 py-2 text-left font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: from.color }} />
                  {from.name}
                </span>
              </th>
              {statuses.map((to) => {
                if (from.key === to.key) {
                  return (
                    <td key={to.key} className="px-3 py-2 text-muted-foreground">
                      <span aria-label="Same status">—</span>
                    </td>
                  );
                }
                const cell = cellState(definition, from.key, to.key);
                // The named transition, if the cell has one: the global one is edited from its own row.
                const own = cell.via.find((t) => t.from !== "*");
                return (
                  <td key={to.key} className={cn("px-3 py-2", cell.onlyGlobal && "bg-muted/20")}>
                    <span className="inline-flex items-center gap-1">
                      <Checkbox
                        aria-label={`Move from ${from.name} to ${to.name}`}
                        title={cell.onlyGlobal ? "Allowed by the move from any status" : undefined}
                        checked={cell.allowed}
                        disabled={readOnly}
                        onChange={(e) => onChange(setMove(definition, from.key, to.key, e.target.checked, nameOf))}
                      />
                      {own && <EditButton name={own.name} ruled={!isPlainTransition(own)} onClick={() => onEditTransition(own.id)} />}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EditButton({ name, ruled, onClick }: { name: string; ruled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Edit transition ${name}`}
      title={ruled ? `${name}: has rules` : name}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2",
        ruled && "text-primary",
      )}
    >
      <SlidersHorizontal className="h-3 w-3" aria-hidden />
      {ruled && <span className="sr-only sm:not-sr-only">Rules</span>}
    </button>
  );
}
