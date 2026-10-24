"use client";

/**
 * The workflow editor's data: queries and mutations over the editor routes
 * (src/app/api/v1/orgs/[orgId]/projects/[projectId]/workflows/**). Every key
 * is org-scoped through useOrgQueryKey.
 */
import { useQuery } from "@tanstack/react-query";
import { FetchError, jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import type { DefinitionIssue, VersionLayout, WorkflowDefinition } from "@/lib/workflow/definition";

export type Category = "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";

export interface ProjectStatus {
  id: string;
  key: string;
  name: string;
  color: string;
  category: Category;
  sortOrder: number;
  archived: boolean;
  items?: number;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  enforcement: "SHADOW" | "ENFORCE";
  published: { version: number; publishedAt: string | null } | null;
  draft: { version: number; createdAt: string } | null;
  assignedTo: (string | null)[];
}

export interface WorkflowVersionRow {
  id: string;
  version: number;
  state: "DRAFT" | "PUBLISHED" | "SUPERSEDED";
  definition: WorkflowDefinition;
  layout: VersionLayout;
  migrationMap: Record<string, string> | null;
  publishedAt: string | null;
}

export interface WorkflowDetail {
  id: string;
  name: string;
  description: string;
  enforcement: "SHADOW" | "ENFORCE";
  assignedTo: (string | null)[];
  draft: WorkflowVersionRow | null;
  published: WorkflowVersionRow | null;
  versions: { id: string; version: number; state: WorkflowVersionRow["state"]; publishedAt: string | null; createdAt: string }[];
}

export interface WorkflowDiff {
  addedStatuses: string[];
  removedStatuses: { key: string; items: number }[];
  addedTransitions: { id: string; name: string }[];
  removedTransitions: { id: string; name: string }[];
  changedTransitions: { id: string; name: string }[];
}

export interface PendingMove {
  workflowId: string;
  workItemTypeId: string | null;
  from: string;
  to: string | null;
  items: number;
}

export interface SimulatedTransition {
  id: string;
  name: string;
  to: string;
  toCategory: Category | null;
  outcome: "available" | "needs_input" | "blocked" | "restricted" | "hidden";
  reasons: string[];
}

export const projectBase = (orgId: string, projectId: string) => `/api/v1/orgs/${orgId}/projects/${projectId}`;

/** What every editor mutation invalidates: the workflows, and what reads statuses or moves. */
export const WORKFLOW_INVALIDATE = [["workflows"], ["statuses"], ["workflow-moves"], ["boards"]];

export function useProjectStatusesFull(orgId: string, projectId: string) {
  return useQuery({
    queryKey: useOrgQueryKey("statuses", projectId, "full"),
    queryFn: () => jsonFetch<ProjectStatus[]>(`${projectBase(orgId, projectId)}/statuses?archived=true&counts=true`),
  });
}

export function useProjectWorkflows(orgId: string, projectId: string) {
  return useQuery({
    queryKey: useOrgQueryKey("workflows", projectId),
    queryFn: () =>
      jsonFetch<{ workflows: WorkflowSummary[]; assignments: { workItemTypeId: string | null; workflowId: string }[] }>(
        `${projectBase(orgId, projectId)}/workflows`,
      ),
  });
}

export function useWorkflow(orgId: string, projectId: string, workflowId: string) {
  return useQuery({
    queryKey: useOrgQueryKey("workflows", projectId, workflowId),
    queryFn: () => jsonFetch<WorkflowDetail>(`${projectBase(orgId, projectId)}/workflows/${workflowId}`),
  });
}

export function useWorkflowMigration(orgId: string, projectId: string) {
  return useQuery({
    queryKey: useOrgQueryKey("workflows", projectId, "migration"),
    queryFn: () => jsonFetch<PendingMove[]>(`${projectBase(orgId, projectId)}/workflow/migration`),
    // While items are moving, watch them go.
    refetchInterval: (q) => ((q.state.data ?? []).some((m) => m.to !== null) ? 3000 : false),
  });
}

export function useWorkflowTemplates(orgId: string) {
  return useQuery({
    queryKey: useOrgQueryKey("workflow-templates"),
    queryFn: () => jsonFetch<{ id: string; name: string; description: string }[]>(`/api/v1/orgs/${orgId}/workflow-templates`),
  });
}

/** A 409 `migration_map_required` body: the statuses to map, and where they may go. */
export interface MapRequired {
  statuses: { key: string; items: number }[];
  options: string[];
}

export function mapRequired(error: unknown): MapRequired | null {
  if (!(error instanceof FetchError) || error.status !== 409) return null;
  const body = error.body as { code?: string } & Partial<MapRequired>;
  return body?.code === "migration_map_required" && body.statuses && body.options
    ? { statuses: body.statuses, options: body.options }
    : null;
}

/** A 422 `workflow_invalid` body's issues. */
export function invalidIssues(error: unknown): DefinitionIssue[] | null {
  if (!(error instanceof FetchError) || error.status !== 422) return null;
  const body = error.body as { code?: string; issues?: DefinitionIssue[] };
  return body?.code === "workflow_invalid" ? (body.issues ?? []) : null;
}
