"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import { Permission } from "@/lib/rbac/permissions";
import { COMPARE_OPERATORS, type ConditionNode, ORG_ROLES, PROJECT_ROLES } from "@/lib/workflow/definition";
import { FieldPicker, Pick } from "./fields";

/**
 * Who may take a transition: conditions on the person and the item, combined
 * with All / Any / None. One builder, so the automations editor (P4) can
 * reuse it and it is learned once.
 *
 * Stored as the definition's ConditionNode: a group is { all } or { any }, and
 * "None" is { not: { any } }.
 */
type Mode = "all" | "any" | "none";

interface Group {
  mode: Mode;
  children: ConditionNode[];
}

function toGroup(node: ConditionNode | undefined): Group {
  if (!node) return { mode: "all", children: [] };
  if ("all" in node) return { mode: "all", children: node.all };
  if ("any" in node) return { mode: "any", children: node.any };
  if ("not" in node && "any" in node.not) return { mode: "none", children: node.not.any };
  return { mode: "all", children: [node] };
}

function fromGroup(g: Group): ConditionNode | undefined {
  if (g.children.length === 0) return undefined;
  if (g.mode === "none") return { not: { any: g.children } };
  return g.mode === "all" ? { all: g.children } : { any: g.children };
}

const isGroup = (n: ConditionNode) => "all" in n || "any" in n || ("not" in n && "any" in n.not);

export const CONDITION_KINDS: { value: string; label: string; make: () => ConditionNode }[] = [
  { value: "actorIsAssignee", label: "The person is an assignee", make: () => ({ kind: "actorIsAssignee" }) },
  { value: "actorIsCreator", label: "The person created the item", make: () => ({ kind: "actorIsCreator" }) },
  { value: "actorHasPermission", label: "The person has a permission", make: () => ({ kind: "actorHasPermission", permission: "ITEM_UPDATE" }) },
  { value: "actorOrgRole", label: "The person's org role is", make: () => ({ kind: "actorOrgRole", in: ["ADMIN"] }) },
  { value: "actorProjectRole", label: "The person's project role is", make: () => ({ kind: "actorProjectRole", in: ["MANAGER"] }) },
  { value: "actorInTeam", label: "The person is in the item's team", make: () => ({ kind: "actorInTeam", teamId: "item" }) },
  { value: "field", label: "A field of the item", make: () => ({ kind: "field", field: { system: "priority" }, op: "eq", value: "HIGH" }) },
  { value: "previousStatus", label: "The item came from", make: () => ({ kind: "previousStatus", in: [] }) },
];

const OP_LABELS: Record<string, string> = {
  eq: "is", ne: "is not", in: "is one of", nin: "is none of", gt: ">", gte: "≥", lt: "<", lte: "≤",
  contains: "contains", isEmpty: "is empty", isNotEmpty: "is not empty",
};
const opts = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: x }));

export function ConditionBuilder({
  value,
  onChange,
  statuses,
  customFields,
  depth = 0,
}: {
  value: ConditionNode | undefined;
  onChange: (next: ConditionNode | undefined) => void;
  statuses: { key: string; name: string }[];
  customFields: { key: string; name: string }[];
  depth?: number;
}) {
  const group = toGroup(value);
  const set = (g: Group) => onChange(fromGroup(g));
  const replace = (i: number, n: ConditionNode | undefined) =>
    set({ ...group, children: n ? group.children.map((c, j) => (j === i ? n : c)) : group.children.filter((_, j) => j !== i) });

  return (
    <div className={depth > 0 ? "rounded-md border border-dashed p-3" : "space-y-3"}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>Match</span>
        <Pick
          label="How the conditions combine"
          value={group.mode}
          onChange={(m) => set({ ...group, mode: m as Mode })}
          options={[
            { value: "all", label: "all of" },
            { value: "any", label: "any of" },
            { value: "none", label: "none of" },
          ]}
          className="min-w-24"
        />
        <span className="text-muted-foreground">these</span>
      </div>
      {group.children.length === 0 && depth === 0 && (
        <p className="text-sm text-muted-foreground">No restriction: anyone who may edit the item can take this transition.</p>
      )}
      <ul className="mt-2 space-y-2">
        {group.children.map((child, i) => (
          <li key={i} className="flex items-start gap-2">
            <div className="flex-1">
              {isGroup(child) ? (
                <ConditionBuilder value={child} onChange={(n) => replace(i, n)} statuses={statuses} customFields={customFields} depth={depth + 1} />
              ) : (
                <ConditionRow node={child} onChange={(n) => replace(i, n)} statuses={statuses} customFields={customFields} />
              )}
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Remove condition" onClick={() => replace(i, undefined)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <Pick
          label="Add a condition"
          value=""
          placeholder="Add a condition…"
          onChange={(k) => {
            const kind = CONDITION_KINDS.find((c) => c.value === k);
            if (kind) set({ ...group, children: [...group.children, kind.make()] });
          }}
          options={CONDITION_KINDS.map(({ value, label }) => ({ value, label }))}
          className="min-w-48"
        />
        {depth === 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => set({ ...group, children: [...group.children, { any: [{ kind: "actorIsAssignee" }] }] })}
          >
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
            Group
          </Button>
        )}
      </div>
    </div>
  );
}

function ConditionRow({
  node,
  onChange,
  statuses,
  customFields,
}: {
  node: ConditionNode;
  onChange: (n: ConditionNode) => void;
  statuses: { key: string; name: string }[];
  customFields: { key: string; name: string }[];
}) {
  if ("all" in node || "any" in node || "not" in node) return null;
  const label = CONDITION_KINDS.find((c) => c.value === node.kind)?.label ?? node.kind;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-sm">
      <span>{label}</span>
      {node.kind === "actorHasPermission" && (
        <Pick
          label="Permission"
          value={node.permission}
          onChange={(p) => onChange({ ...node, permission: p as typeof node.permission })}
          options={opts(Object.keys(Permission))}
          className="min-w-48"
        />
      )}
      {(node.kind === "actorOrgRole" || node.kind === "actorProjectRole") && (
        <SearchableMultiSelect
          aria-label={node.kind === "actorOrgRole" ? "Org roles" : "Project roles"}
          value={node.in}
          onValueChange={(v) => v.length > 0 && onChange({ ...node, in: v })}
          options={opts(node.kind === "actorOrgRole" ? ORG_ROLES : PROJECT_ROLES)}
          size="sm"
          className="min-w-48"
        />
      )}
      {node.kind === "actorInTeam" && (
        <Input
          aria-label="Team id, or item for the item's own team"
          className="h-8 w-48"
          value={node.teamId}
          onChange={(e) => e.target.value && onChange({ ...node, teamId: e.target.value })}
        />
      )}
      {node.kind === "previousStatus" && (
        <SearchableMultiSelect
          aria-label="Previous statuses"
          value={node.in}
          onValueChange={(v) => onChange({ ...node, in: v })}
          options={statuses.map((s) => ({ value: s.key, label: s.name }))}
          size="sm"
          className="min-w-48"
        />
      )}
      {node.kind === "field" && (
        <>
          <FieldPicker value={node.field} onChange={(field) => onChange({ ...node, field })} customFields={customFields} />
          <Pick
            label="Comparison"
            value={node.op}
            onChange={(op) => onChange({ ...node, op: op as typeof node.op })}
            options={[...COMPARE_OPERATORS, "isEmpty", "isNotEmpty"].map((o) => ({ value: o, label: OP_LABELS[o] }))}
            className="min-w-28"
          />
          {node.op !== "isEmpty" && node.op !== "isNotEmpty" && (
            <Input
              aria-label="Value"
              className="h-8 w-40"
              value={Array.isArray(node.value) ? node.value.join(", ") : String(node.value ?? "")}
              onChange={(e) => {
                const raw = e.target.value;
                const value = node.op === "in" || node.op === "nin" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : raw;
                onChange({ ...node, value });
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
