"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Pick } from "@/components/workflow/fields";
import { useProjectStatusesFull } from "@/components/workflow/api";
import { useProjectMembers } from "@/components/intervals/use-project-members";
import { useProjectTeams } from "@/hooks/use-project-teams";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { automationSpecSchema } from "@/lib/automation/spec";
import { describeRule } from "@/lib/automation/describe";
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "@/lib/automation/templates";
import {
  AUTOMATION_INVALIDATE,
  automationsBase,
  isStale,
  ruleIssuesOf,
  useAutomationRules,
  useIntervalChoices,
  useWebhookChoices,
  type AutomationRule,
  type RuleIssue,
  type SavedRule,
} from "./api";
import { RuleEditor, type RuleChoices, type RuleDraft } from "./rule-editor";
import { RunLog } from "./run-log";

type Editing = { rule: AutomationRule | null; draft: RuleDraft | null; templateKey?: string };

/**
 * A project's automation rules (workflow design §5): the list with each rule
 * in a sentence, switching rules on and off, the builder, the v1 templates,
 * each rule's runs, and the warning when rules could keep firing each other.
 */
export function AutomationsOverview({ orgId, projectId, canManageWebhooks }: { orgId: string; projectId: string; canManageWebhooks: boolean }) {
  const rules = useAutomationRules(orgId, projectId);
  const statuses = useProjectStatusesFull(orgId, projectId);
  const members = useProjectMembers(orgId, projectId);
  const teams = useProjectTeams(orgId, projectId);
  const intervals = useIntervalChoices(orgId, projectId, true);
  const webhooks = useWebhookChoices(orgId, canManageWebhooks);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [issues, setIssues] = useState<RuleIssue[]>([]);
  const [picking, setPicking] = useState(false);
  const [runsFor, setRunsFor] = useState<AutomationRule | null>(null);
  const [warnings, setWarnings] = useState<{ name: string; messages: string[] } | null>(null);

  const live = (statuses.data ?? []).filter((s) => !s.archived);
  const statusName = (key: string) => statuses.data?.find((s) => s.key === key)?.name ?? key;
  const choices: RuleChoices = {
    statuses: live.map((s) => ({ key: s.key, name: s.name, category: s.category })),
    members: (members.data ?? []).filter((m) => !m.isBot).map((m) => ({ userId: m.userId, displayName: m.displayName })),
    teams: (teams.data ?? []).map((t) => ({ id: t.id, name: t.name })),
    intervals: (intervals.data ?? []).map((i) => ({ id: i.id, name: i.name })),
    webhooks: canManageWebhooks && webhooks.data ? webhooks.data.filter((w) => w.active).map((w) => ({ id: w.id, url: w.url })) : null,
  };

  const saved = (rule: SavedRule, verb: string) => {
    toast.success(`Rule ${verb}.`);
    setWarnings(rule.warnings.length ? { name: rule.name, messages: rule.warnings } : null);
  };
  const failed = (e: unknown) => {
    const found = ruleIssuesOf(e);
    if (found) return setIssues(found);
    if (isStale(e)) {
      void rules.refetch();
      if (!editing) return void toast.error("Someone else changed this rule. It's been reloaded: try again.");
      return setIssues([{ path: "", message: "Someone else changed this rule since you opened it. Close it, and open it again to see their changes." }]);
    }
    notifyError(e);
  };

  const create = useOrgMutation({
    mutationFn: (body: { name: string; spec: unknown; allowChain: boolean; templateKey?: string }) =>
      jsonFetch<SavedRule>(automationsBase(orgId), { method: "POST", body: JSON.stringify({ projectId, ...body }) }),
    invalidate: AUTOMATION_INVALIDATE,
    onSuccess: (rule) => {
      setEditing(null);
      setPicking(false);
      saved(rule, "created");
    },
    onError: failed,
  });
  const update = useOrgMutation({
    mutationFn: ({ id, ...body }: { id: string; revision: number; name?: string; spec?: unknown; allowChain?: boolean; enabled?: boolean }) =>
      jsonFetch<SavedRule>(`${automationsBase(orgId)}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    invalidate: AUTOMATION_INVALIDATE,
    onSuccess: (rule, vars) => {
      setEditing(null);
      saved(rule, vars.enabled === undefined ? "saved" : vars.enabled ? "switched on" : "switched off");
    },
    onError: failed,
  });
  const remove = useOrgMutation({
    mutationFn: (id: string) => jsonFetch(`${automationsBase(orgId)}/${id}`, { method: "DELETE" }),
    invalidate: AUTOMATION_INVALIDATE,
    onSuccess: () => toast.success("Rule deleted."),
  });

  const open = (next: Editing) => {
    setIssues([]);
    setEditing(next);
  };
  const onSave = (draft: RuleDraft) => {
    setIssues([]);
    const body = { name: draft.name, spec: draft.spec, allowChain: draft.allowChain };
    if (editing?.rule) update.mutate({ id: editing.rule.id, revision: editing.rule.revision, ...body });
    else create.mutate({ ...body, ...(editing?.templateKey && { templateKey: editing.templateKey }) });
  };

  if (rules.isError) return <LoadError title="Couldn't load the automations" onRetry={() => void rules.refetch()} />;
  if (!rules.data || !statuses.data) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => open({ rule: null, draft: null })}>
          <Plus className="size-4" /> New rule
        </Button>
        <Button variant="outline" onClick={() => setPicking(true)}>
          <Wand2 className="size-4" /> Start from a template
        </Button>
      </div>

      {warnings && (
        <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">Saved &ldquo;{warnings.name}&rdquo;, with a warning</p>
              {warnings.messages.map((m, i) => (
                <p key={i} className="mt-1 text-xs">
                  {m}
                </p>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setWarnings(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {rules.data.length === 0 ? (
        <EmptyState title="No automations yet" description="A rule moves, assigns, labels, comments or notifies when something happens to an item, or on a schedule." />
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Automation rules">
          {rules.data.map((rule) => {
            const spec = automationSpecSchema.safeParse(rule.spec);
            return (
              <li key={rule.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <ToggleSwitch
                  checked={rule.enabled}
                  aria-label={`Run ${rule.name}`}
                  disabled={update.isPending}
                  onCheckedChange={(enabled) => update.mutate({ id: rule.id, revision: rule.revision, enabled })}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{rule.name}</span>
                    {!rule.enabled && <Badge variant="neutral">Off</Badge>}
                    {rule.allowChain && <Badge variant="discovery">Chains</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {spec.success ? describeRule(spec.data, statusName) : "Its settings can't be read: open it and save it again."}
                  </p>
                  {rule.disabledReason && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Switched off: {rule.disabledReason}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setRunsFor(rule)}>
                    Runs
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!spec.success}
                    onClick={() => spec.success && open({ rule, draft: { name: rule.name, spec: spec.data, allowChain: rule.allowChain } })}
                  >
                    Edit
                  </Button>
                  <ConfirmButton size="sm" variant="ghost" confirmLabel="Delete" pending={remove.isPending} onConfirm={() => remove.mutate(rule.id)}>
                    Delete
                  </ConfirmButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <RuleEditor
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        initial={editing?.draft ?? null}
        title={editing?.rule ? `Edit ${editing.rule.name}` : "New rule"}
        choices={choices}
        saving={create.isPending || update.isPending}
        serverIssues={issues}
        onSave={onSave}
      />
      <TemplatePicker
        open={picking}
        onOpenChange={setPicking}
        choices={choices}
        onCustomize={(t, values) => {
          setPicking(false);
          open({ rule: null, draft: { name: t.name, spec: t.build(values), allowChain: false }, templateKey: t.key });
        }}
        onCreate={(t, values) => {
          setIssues([]);
          create.mutate({ name: t.name, spec: t.build(values), allowChain: false, templateKey: t.key });
        }}
        creating={create.isPending}
        issues={picking ? issues : []}
      />
      <RunLog orgId={orgId} rule={runsFor} onOpenChange={(o) => !o && setRunsFor(null)} />
    </div>
  );
}

/** The v1 templates: pick one, say what it needs (a status, a number of days), and create it or open it in the builder first. */
function TemplatePicker({
  open,
  onOpenChange,
  choices,
  onCreate,
  onCustomize,
  creating,
  issues,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  choices: RuleChoices;
  onCreate: (t: AutomationTemplate, values: Record<string, string | number>) => void;
  onCustomize: (t: AutomationTemplate, values: Record<string, string | number>) => void;
  creating: boolean;
  issues: RuleIssue[];
}) {
  const [key, setKey] = useState(AUTOMATION_TEMPLATES[0].key);
  const [values, setValues] = useState<Record<string, string | number>>({});
  const t = AUTOMATION_TEMPLATES.find((x) => x.key === key)!;
  const filled = Object.fromEntries(
    t.params.map((p) => [p.key, values[p.key] ?? (p.kind === "days" ? p.default : (choices.statuses.find((s) => p.categories.includes(s.category))?.key ?? ""))]),
  );
  const missing = t.params.filter((p) => p.kind === "status" && !filled[p.key]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Start from a template</DialogTitle>
          <DialogDescription>Each one makes an ordinary rule you can change afterwards.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
          <div role="radiogroup" aria-label="Templates" className="grid content-start gap-1">
            {AUTOMATION_TEMPLATES.map((x) => (
              <button
                key={x.key}
                type="button"
                role="radio"
                aria-checked={x.key === key}
                onClick={() => {
                  setKey(x.key);
                  setValues({});
                }}
                className={`rounded-md px-2 py-1.5 text-left text-sm ${x.key === key ? "bg-accent font-medium" : "hover:bg-accent/50"}`}
              >
                {x.name}
              </button>
            ))}
          </div>
          <div className="grid content-start gap-3 text-sm">
            <p>{t.description}</p>
            {t.params.map((p) =>
              p.kind === "status" ? (
                <label key={p.key} className="grid gap-1">
                  <span className="text-xs text-muted-foreground">{p.label}</span>
                  <Pick
                    label={p.label}
                    value={String(filled[p.key])}
                    onChange={(v) => setValues((s) => ({ ...s, [p.key]: v }))}
                    options={choices.statuses.filter((s) => p.categories.includes(s.category)).map((s) => ({ value: s.key, label: s.name }))}
                  />
                </label>
              ) : (
                <label key={p.key} className="grid gap-1">
                  <span className="text-xs text-muted-foreground">{p.label}</span>
                  <Input
                    aria-label={p.label}
                    type="number"
                    min={p.min}
                    max={p.max}
                    className="w-28"
                    value={filled[p.key]}
                    onChange={(e) => setValues((s) => ({ ...s, [p.key]: Math.max(p.min, Math.min(p.max, Math.trunc(Number(e.target.value) || p.min))) }))}
                  />
                </label>
              ),
            )}
            {missing.length > 0 && <p className="text-xs text-destructive">This project has no status for &ldquo;{missing[0].label}&rdquo;. Add one in its workflow first.</p>}
            {issues.length > 0 && (
              <ul role="alert" className="list-disc pl-5 text-xs text-destructive">
                {issues.map((x, i) => (
                  <li key={i}>{x.message}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={missing.length > 0} onClick={() => onCustomize(t, filled)}>
            Customize first
          </Button>
          <Button disabled={missing.length > 0 || creating} onClick={() => onCreate(t, filled)}>
            Create rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
