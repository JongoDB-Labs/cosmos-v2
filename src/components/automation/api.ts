"use client";

/**
 * The Automations screen's data: queries over the automation routes
 * (src/app/api/v1/orgs/[orgId]/automations/**) and what the rule builder
 * picks from. Every key is org-scoped through useOrgQueryKey.
 */
import { useQuery } from "@tanstack/react-query";
import { FetchError, jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";

export interface AutomationRule {
  id: string;
  projectId: string | null;
  name: string;
  enabled: boolean;
  /** As stored; parse with automationSpecSchema before editing. */
  spec: unknown;
  revision: number;
  ownerId: string | null;
  allowChain: boolean;
  templateKey: string | null;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SavedRule = AutomationRule & { warnings: string[] };

export type RunStatus = "SUCCESS" | "PARTIAL" | "FAILED" | "NO_MATCH" | "SKIPPED_SELF" | "LOOP" | "THROTTLED";

export interface AutomationRunRow {
  id: string;
  ruleRevision: number;
  eventId: string | null;
  depth: number;
  status: RunStatus;
  itemsMatched: number;
  /** Each action's outcome, or one `{ note }` saying why nothing ran. */
  actions: ({ kind: string; itemId: string; ok: boolean; noop?: boolean; error?: string } | { note: string })[];
  durationMs: number;
  createdAt: string;
}

export const RUNS_SHOWN = 50;

export const automationsBase = (orgId: string) => `/api/v1/orgs/${orgId}/automations`;

/** What every rule mutation invalidates. */
export const AUTOMATION_INVALIDATE = [["automations"]];

export function useAutomationRules(orgId: string, projectId: string) {
  return useQuery({
    queryKey: useOrgQueryKey("automations", projectId),
    queryFn: () => jsonFetch<AutomationRule[]>(`${automationsBase(orgId)}?projectId=${projectId}`),
  });
}

export function useAutomationRuns(orgId: string, ruleId: string | null) {
  return useQuery({
    queryKey: useOrgQueryKey("automations", "runs", ruleId),
    enabled: ruleId !== null,
    queryFn: () => jsonFetch<AutomationRunRow[]>(`${automationsBase(orgId)}/${ruleId}/runs?limit=${RUNS_SHOWN}`),
  });
}

/** The org's webhooks, for the webhook action. Needs webhook-manage; anyone else sees none to pick. */
export function useWebhookChoices(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: useOrgQueryKey("automations", "webhook-choices"),
    enabled,
    retry: false,
    queryFn: () => jsonFetch<{ id: string; url: string; active: boolean }[]>(`/api/v1/orgs/${orgId}/webhooks`),
  });
}

/** The project's sprints and other intervals, for "set the interval". */
export function useIntervalChoices(orgId: string, projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: useOrgQueryKey("automations", "interval-choices", projectId),
    enabled,
    queryFn: () => jsonFetch<{ id: string; name: string; status: string }[]>(`/api/v1/orgs/${orgId}/projects/${projectId}/intervals`),
  });
}

export interface RuleIssue {
  path: string;
  message: string;
}

/** A 422 `automation_invalid` body's issues. */
export function ruleIssuesOf(error: unknown): RuleIssue[] | null {
  if (!(error instanceof FetchError) || error.status !== 422) return null;
  const body = error.body as { code?: string; issues?: RuleIssue[] };
  return body?.code === "automation_invalid" ? (body.issues ?? []) : null;
}

/** A 409: someone saved the rule since it was loaded. */
export const isStale = (error: unknown) => error instanceof FetchError && error.status === 409;
