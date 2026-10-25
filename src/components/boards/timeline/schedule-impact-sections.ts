/**
 * Core's own rows for the confirm step (ScheduleImpactDialog), built on the
 * client from the preview's ISO dates so every date is the viewer's local day,
 * the same day the chart draws. Plugin sections arrive preformatted and are
 * appended after these.
 */
import type { ImpactSection, ImpactTone, ScheduleChange } from "@/lib/work-items/schedule-impact";
import { formatRange } from "./schedule-announcement";

export interface PreviewForDialog {
  changes: ScheduleChange[];
  cascaded: (ScheduleChange & { reason: "successor-shift" | "parent-envelope" })[];
  allocation: {
    userId: string;
    name: string;
    weeklyCapacityHours: number | null;
    peakBefore: number;
    peakAfter: number;
    pointsBefore: number;
    pointsAfter: number;
  }[];
  sections: ImpactSection[];
}

const DAY = 86_400_000;
const localDay = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const days = (n: number) => `${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"}`;

/** "3 days later", "2 days longer", or both. */
export function shiftText(c: ScheduleChange): string | undefined {
  const { before: b, after: a } = c;
  if (!b.startDate || !b.dueDate || !a.startDate || !a.dueDate) return undefined;
  const moved = Math.round((localDay(a.startDate) - localDay(b.startDate)) / DAY);
  const grew =
    Math.round((localDay(a.dueDate) - localDay(a.startDate)) / DAY) -
    Math.round((localDay(b.dueDate) - localDay(b.startDate)) / DAY);
  const parts = [
    moved !== 0 ? `${days(moved)} ${moved > 0 ? "later" : "earlier"}` : null,
    grew !== 0 ? `${days(grew)} ${grew > 0 ? "longer" : "shorter"}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

const WHY = {
  "successor-shift": "waits on a moved item",
  "parent-envelope": "widened to fit its items",
} as const;

export function coreImpactSections(p: PreviewForDialog, labelFor: (id: string) => string): ImpactSection[] {
  const out: ImpactSection[] = [];
  out.push({
    key: "schedule",
    title: p.changes.length === 1 ? "The change" : "The changes",
    rows: p.changes.map((c) => ({
      key: `item:${c.itemId}`,
      label: labelFor(c.itemId),
      before: formatRange(c.before),
      after: formatRange(c.after),
      delta: shiftText(c),
      tone: "neutral",
    })),
  });
  if (p.cascaded.length > 0) {
    out.push({
      key: "dependencies",
      title: p.cascaded.length === 1 ? "Also moves" : `Also moves (${p.cascaded.length})`,
      rows: p.cascaded.map((c) => ({
        key: `item:${c.itemId}`,
        label: `${labelFor(c.itemId)}, ${WHY[c.reason]}`,
        before: formatRange(c.before),
        after: formatRange(c.after),
        delta: shiftText(c),
        tone: "warn",
      })),
    });
  }
  if (p.allocation.length > 0) {
    out.push({
      key: "allocation",
      title: "People",
      rows: p.allocation.map((a) => {
        const tone: ImpactTone =
          a.peakAfter > a.peakBefore && a.peakAfter > 1 ? "warn" : a.peakAfter < a.peakBefore ? "positive" : "neutral";
        const points = a.pointsAfter !== a.pointsBefore ? `${a.pointsBefore} → ${a.pointsAfter} points in this window` : undefined;
        return {
          key: `person:${a.userId}`,
          label: a.weeklyCapacityHours != null ? `${a.name} (${a.weeklyCapacityHours} h a week)` : a.name,
          before: `${a.peakBefore} at once`,
          after: `${a.peakAfter} at once`,
          delta: points,
          tone,
        };
      }),
    });
  }
  return [...out, ...p.sections];
}
