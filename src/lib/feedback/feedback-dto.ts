/**
 * What a feedback item looks like on the wire, per viewer.
 *
 * The routes used to spread the raw row, so every org member received fields
 * that were never meant for them: `telemetry` (stack traces and environment
 * captured with a bug report), the raw `triage` JSON (the AI triage and the
 * security judge's reasoning), and every author's email address. The portal
 * reads none of them; it shows the derived `intake` decision instead.
 *
 * So the shape is built field by field, never by spreading the row:
 *   - everyone: the item's own content and state, `intake`, `authorName`;
 *   - the author, or staff (ORG_UPDATE): `authorEmail`;
 *   - staff only: `telemetry` and the raw `triage`.
 *
 * `intake` is scoped too (see `scopeIntake`): its reason can carry the security
 * judge's own words, and its score says how close a submission came to the
 * line. Both help someone tune a submission past the gate.
 */
import type { FeedbackItem, FeedbackStatus, FeedbackType } from "@prisma/client";
import {
  describeIntakeDecision,
  type IntakeDecision,
  type IntakeState,
} from "./intake-decision";

/** The columns a feedback response is built from. */
export const FEEDBACK_ROW_SELECT = {
  id: true,
  orgId: true,
  authorId: true,
  type: true,
  title: true,
  description: true,
  status: true,
  voteCount: true,
  source: true,
  sourceRef: true,
  deliveredAt: true,
  workItemId: true,
  projectId: true,
  createdAt: true,
  updatedAt: true,
  commentCount: true,
  lastActivityAt: true,
  mergedIntoId: true,
  lockedAt: true,
  // Read for `intake` (everyone) and passed through to staff only.
  triage: true,
  telemetry: true,
} as const;

export type FeedbackRow = Pick<FeedbackItem, keyof typeof FEEDBACK_ROW_SELECT>;

export interface FeedbackViewer {
  userId: string;
  /** Holds ORG_UPDATE: triages the queue, so may see what intake recorded. */
  isStaff: boolean;
}

export interface FeedbackAuthor {
  displayName: string | null;
  email: string | null;
}

/**
 * What the author is told about their own item's intake: a fixed sentence per
 * outcome, never the judge's reasoning. Written for the person who filed it.
 */
const AUTHOR_INTAKE_REASON: Record<IntakeState, string> = {
  accepted: "Accepted and added to the backlog.",
  held: "Held for someone on the team to review before anything else happens.",
  rejected: "Not accepted by the automated intake check. Someone on the team can review it.",
  throttled: "Queued. It will be picked up automatically once there is capacity.",
  gated: "Routed to a teammate for review before any automated work.",
};

/** The intake decision as this viewer may see it. */
export type IntakeView = Pick<IntakeDecision, "state" | "label"> & {
  reason?: string;
  score: number | null;
  categories?: string[];
};

export function scopeIntake(
  decision: IntakeDecision | null,
  { isStaff, isAuthor }: { isStaff: boolean; isAuthor: boolean },
): IntakeView | null {
  if (!decision) return null;
  if (isStaff) return decision;
  const base = { state: decision.state, label: decision.label, score: null };
  return isAuthor ? { ...base, reason: AUTHOR_INTAKE_REASON[decision.state] } : base;
}

export interface FeedbackDto {
  id: string;
  orgId: string;
  authorId: string;
  type: FeedbackType;
  title: string;
  description: string;
  status: FeedbackStatus;
  voteCount: number;
  source: string;
  sourceRef: string | null;
  deliveredAt: Date | null;
  workItemId: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Public, non-deleted comments. */
  commentCount: number;
  lastActivityAt: Date | null;
  mergedIntoId: string | null;
  lockedAt: Date | null;
  isMine: boolean;
  authorName: string | null;
  intake: IntakeView | null;
  authorEmail?: string | null;
  telemetry?: FeedbackItem["telemetry"];
  triage?: FeedbackItem["triage"];
}

export function toFeedbackDto(
  row: FeedbackRow,
  viewer: FeedbackViewer,
  author?: FeedbackAuthor | null,
): FeedbackDto {
  const isMine = row.authorId === viewer.userId;
  const dto: FeedbackDto = {
    id: row.id,
    orgId: row.orgId,
    authorId: row.authorId,
    type: row.type,
    title: row.title,
    description: row.description,
    status: row.status,
    voteCount: row.voteCount,
    source: row.source,
    sourceRef: row.sourceRef,
    deliveredAt: row.deliveredAt,
    workItemId: row.workItemId,
    projectId: row.projectId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    commentCount: row.commentCount,
    lastActivityAt: row.lastActivityAt,
    mergedIntoId: row.mergedIntoId,
    lockedAt: row.lockedAt,
    // The author owns the item's title/description (and can delete it), so
    // the portal shows those controls only on the current user's own items.
    isMine,
    authorName: author?.displayName ?? null,
    // Intake decision (Phase 3c), derived from the recorded triage so the board
    // can show whether an item was accepted or held, scoped per viewer.
    intake: scopeIntake(describeIntakeDecision({ triage: row.triage, deliveredAt: row.deliveredAt }), {
      isStaff: viewer.isStaff,
      isAuthor: isMine,
    }),
  };
  if (isMine || viewer.isStaff) dto.authorEmail = author?.email ?? null;
  if (viewer.isStaff) {
    dto.telemetry = row.telemetry;
    dto.triage = row.triage;
  }
  return dto;
}
