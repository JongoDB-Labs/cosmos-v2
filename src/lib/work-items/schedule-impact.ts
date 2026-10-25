/**
 * What a schedule change on the Gantt would do, shown before it is saved.
 *
 * Client-safe: the confirm dialog renders these, and a plugin's own schedule
 * page can mount the same dialog with sections from its own preview. Core fills
 * the sections it can compute (the dates that move, what the cascade pushes, who
 * ends up with more running at once); a plugin can add its own through
 * `PluginServerHooks.scheduleImpact` (fee, effective rate, hours). Data only: no
 * plugin UI is rendered by core, every value is a preformatted string, so the
 * plugin owns its currency and units.
 */
import { z } from "zod";

export const IMPACT_TONES = ["neutral", "positive", "warn", "critical"] as const;
export type ImpactTone = (typeof IMPACT_TONES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);

export const ImpactRowSchema = z.object({
  /** Stable within its section ("fee", "effective_rate", "item:<id>"), so rows
   *  keep their place across re-previews and tests can name them. */
  key: text(120),
  label: text(200),
  before: text(120).optional(),
  after: text(120).optional(),
  delta: text(120).optional(),
  tone: z.enum(IMPACT_TONES),
});
export type ImpactRow = z.infer<typeof ImpactRowSchema>;

export const ImpactSectionSchema = z.object({
  /** Stable section id. Core's are "schedule", "dependencies" and "allocation";
   *  a plugin's are prefixed with its slug by core ("<slug>:<key>"). */
  key: text(120),
  title: text(120),
  rows: z.array(ImpactRowSchema).max(50),
  /** A nudge to act, e.g. "Add 12 h or a person to keep the end date". */
  prompt: z
    .object({
      message: text(400),
      // Same-origin paths only: a plugin may point into its own pages, never
      // off-site. Not "//host" and not "/\\host": browsers read a backslash as a
      // slash, so either would leave the site.
      action: z
        .object({ label: text(60), href: z.string().regex(/^\/(?![\/\\])[^\s\\]*$/, "a same-origin path") })
        .optional(),
    })
    .optional(),
});
export type ImpactSection = z.infer<typeof ImpactSectionSchema>;

/**
 * A change to something core doesn't schedule (a plugin's own phases, say),
 * passed through the same preview to the plugin that owns it. Its `kind` is
 * "<plugin slug>.<name>", and only that plugin ever sees it.
 */
export const PLUGIN_CHANGE_KIND = /^([a-z0-9][a-z0-9-]*)\.[a-z0-9][a-z0-9_-]*$/;
export const WORK_ITEM_KIND = "workItem";

export interface PluginScheduleChange {
  kind: string;
  id: string;
  startDate: string | null;
  dueDate: string | null;
}

export interface ScheduleRange {
  startDate: string | null;
  dueDate: string | null;
}

export interface ScheduleChange {
  itemId: string;
  before: ScheduleRange;
  after: ScheduleRange;
}

/** What the preview endpoint answers. */
export interface SchedulePreview {
  /** Every item the change and its cascade would move, the dragged ones first. */
  changes: ScheduleChange[];
  cascaded: (ScheduleChange & { reason: "successor-shift" | "parent-envelope" })[];
  sections: ImpactSection[];
  /** Worth stopping for: something besides the dragged bars moves, someone's
   *  load rises, or a plugin had something to say. A plain move saves at once. */
  needsConfirm: boolean;
}
