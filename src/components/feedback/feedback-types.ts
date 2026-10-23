/**
 * The feedback board's client-side shapes and labels, shared by the portal and
 * its detail dialog so the two never disagree about what an item looks like.
 */

export type FType = "BUG" | "FEATURE";
export type FStatus = "OPEN" | "PLANNED" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "DECLINED";

export interface FeedbackAttachment {
  id: string;
  kind: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface FeedbackItem {
  id: string;
  type: FType;
  title: string;
  description: string;
  status: FStatus;
  voteCount: number;
  hasVoted: boolean;
  // True when the current user authored this item — they own its title/
  // description and may delete it, regardless of ORG_UPDATE.
  isMine: boolean;
  createdAt: string;
  attachments?: FeedbackAttachment[];
  projectId?: string | null;
  // Submitter identity (resolved server-side — FeedbackItem has no User
  // relation). Prefer the display name, falling back to email; either can be
  // null if the author's User row no longer exists.
  authorName?: string | null;
  authorEmail?: string | null;
  // Intake decision surfaced by the guardrail pipeline (Phase 3c): accepted /
  // held / rejected / throttled / gated + reason (+ score). Null until intake ran.
  intake?: IntakeDecision | null;
}

export type IntakeState = "accepted" | "held" | "rejected" | "throttled" | "gated";

export interface IntakeDecision {
  state: IntakeState;
  label: string;
  /** Staff see the full reason; the author a fixed sentence; others none. */
  reason?: string;
  score: number | null;
  categories?: string[];
}

// Badge tone per intake state — accepted reads positive, the safety parks read
// as review/blocked, a throttle is neutral.
export const INTAKE_BADGE_VARIANT: Record<IntakeState, "done" | "review" | "blocked" | "neutral"> = {
  accepted: "done",
  held: "review",
  rejected: "blocked",
  throttled: "neutral",
  gated: "review",
};

/** "Reported by <name>", preferring display name and falling back to email.
 *  Returns null when neither resolved (e.g. the author's User row is gone). */
export function reporterLabel(item: Pick<FeedbackItem, "authorName" | "authorEmail">): string | null {
  const who = item.authorName || item.authorEmail;
  return who ? `Reported by ${who}` : null;
}

export const STATUS_LABELS: Record<FStatus, string> = {
  OPEN: "Open",
  PLANNED: "Planned",
  IN_PROGRESS: "In progress",
  IN_REVIEW: "In review",
  DONE: "Done",
  DECLINED: "Declined",
};

export const STATUS_ORDER: FStatus[] = [
  "OPEN",
  "PLANNED",
  "IN_PROGRESS",
  "IN_REVIEW",
  "DONE",
  "DECLINED",
];
