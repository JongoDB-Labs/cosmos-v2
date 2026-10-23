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
 */
import type { FeedbackItem, FeedbackStatus, FeedbackType } from "@prisma/client";
import { describeIntakeDecision, type IntakeDecision } from "./intake-decision";

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
  isMine: boolean;
  authorName: string | null;
  intake: IntakeDecision | null;
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
    // The author owns the item's title/description (and can delete it), so
    // the portal shows those controls only on the current user's own items.
    isMine,
    authorName: author?.displayName ?? null,
    // Intake decision (Phase 3c), derived from the recorded triage so the board
    // can show WHY an item was accepted or held — without the raw reasoning.
    intake: describeIntakeDecision({ triage: row.triage, deliveredAt: row.deliveredAt }),
  };
  if (isMine || viewer.isStaff) dto.authorEmail = author?.email ?? null;
  if (viewer.isStaff) {
    dto.telemetry = row.telemetry;
    dto.triage = row.triage;
  }
  return dto;
}
