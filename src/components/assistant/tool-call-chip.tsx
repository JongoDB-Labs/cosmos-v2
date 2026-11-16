"use client";

import { Hourglass, Loader2, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { toolCallOutcome, type ToolCallLike } from "@/lib/assistant/tool-status";

// Friendly badges for known tools; falls back to `Running ${name}` for
// anything not listed. Keep verbs in the present-progressive — these labels
// surface while the tool is still executing.
const TOOL_LABELS: Record<string, string> = {
  create_project: "Creating project",
  update_project: "Updating project",
  delete_project: "Deleting project",
  list_projects: "Listing projects",
  get_project: "Loading project",
  create_work_item: "Creating work item",
  update_work_item: "Updating work item",
  delete_work_item: "Deleting work item",
  list_work_items: "Listing work items",
  create_okr: "Creating OKR",
  update_okr: "Updating OKR",
  list_okrs: "Listing OKRs",
  send_email: "Sending email",
  search_emails: "Searching emails",
  list_emails: "Listing emails",
  create_calendar_event: "Creating calendar event",
  list_calendar_events: "Listing calendar events",
  search_files: "Searching files",
  read_file: "Reading file",
  write_file: "Writing file",
};

export function labelForTool(name: string | undefined): string {
  if (!name) return "Running tool";
  return TOOL_LABELS[name] ?? `Running ${name}`;
}

/**
 * Convert a present-progressive tool label ("Creating project") to its
 * past-tense form ("Created project") for the post-execution badge.
 * Falls back to `Ran ${name}` when we don't have a canonical mapping —
 * the naive `-ing` → `-ed` substitution produces garbage like "Runned".
 */
function pastTenseLabel(name: string | undefined): string {
  if (!name) return "Ran tool";
  const known = TOOL_LABELS[name];
  if (!known) return `Ran ${name}`;
  // Curated past-tense mappings keyed by the canonical present label.
  // Anything not listed falls through to a regex substitution that handles
  // the common "Verbing" → "Verbed" / "Verb-y" → "Verbed" cases.
  const map: Record<string, string> = {
    "Creating project": "Created project",
    "Updating project": "Updated project",
    "Deleting project": "Deleted project",
    "Listing projects": "Listed projects",
    "Loading project": "Loaded project",
    "Creating work item": "Created work item",
    "Updating work item": "Updated work item",
    "Deleting work item": "Deleted work item",
    "Listing work items": "Listed work items",
    "Creating OKR": "Created OKR",
    "Updating OKR": "Updated OKR",
    "Listing OKRs": "Listed OKRs",
    "Sending email": "Sent email",
    "Searching emails": "Searched emails",
    "Listing emails": "Listed emails",
    "Creating calendar event": "Created calendar event",
    "Listing calendar events": "Listed calendar events",
    "Searching files": "Searched files",
    "Reading file": "Read file",
    "Writing file": "Wrote file",
  };
  return map[known] ?? known;
}

/** `delete_board` -> "delete board": a tool's name as a plain phrase. */
function toolPhrase(name: string | undefined): string {
  return (name ?? "tool").replace(/_/g, " ");
}

/**
 * The chip for one tool call in an assistant message. It says what the call
 * came to (see `toolCallOutcome`): a preview waiting for the user's yes reads
 * as a proposal and a refusal as not done, never as the change itself.
 */
export function ToolCallChip({ tc }: { tc: ToolCallLike }) {
  const outcome = toolCallOutcome(tc);
  const label =
    outcome === "running"
      ? `${labelForTool(tc.name)}…`
      : outcome === "proposed"
        ? `Proposed: ${toolPhrase(tc.name)}`
        : outcome === "refused"
          ? `Not done: ${toolPhrase(tc.name)}`
          : pastTenseLabel(tc.name);
  const Icon = outcome === "running" ? Loader2 : outcome === "proposed" ? Hourglass : outcome === "refused" ? X : Wrench;
  return (
    <span
      data-testid="tool-call-chip"
      data-outcome={outcome}
      title={outcome === "proposed" ? "Nothing has changed yet. This is waiting for your yes." : undefined}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]",
        outcome === "running"
          ? "border-primary/30 bg-primary/10 text-primary"
          : outcome === "proposed"
            ? "border-dashed border-border bg-background text-foreground"
            : "border-border bg-background text-muted-foreground",
      )}
    >
      <Icon className={cn("size-3", outcome === "running" && "animate-spin")} aria-hidden />
      {label}
    </span>
  );
}
