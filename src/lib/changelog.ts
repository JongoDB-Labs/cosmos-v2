/**
 * Product changelog for the in-app "What's new" modal (FR: catch users up on new
 * features/fixes when a version ships, SaaS-style). Keep it USER-FACING — describe
 * the value, not the implementation — and add an entry whenever you bump the app
 * version for something users would notice. Newest first; `CHANGELOG[0]` is latest.
 */

export type ChangeKind = "feature" | "improvement" | "fix";

export interface ChangeEntry {
  kind: ChangeKind;
  text: string;
}

export interface Release {
  version: string; // "2.157.0"
  date: string; // ISO date, "2026-07-07"
  title: string; // short headline
  highlights: ChangeEntry[];
}

export const CHANGELOG: Release[] = [
  {
    version: "2.162.0",
    date: "2026-07-10",
    title: "Your sub-item order now carries over to the Timeline",
    highlights: [
      {
        kind: "improvement",
        text: "When you drag to reorder the sub-items under an epic, story, or task, that order now shows up on the Timeline (Gantt) too — sub-items line up in the sequence you chose instead of by start date. The order is saved and looks the same for everyone on your team. Sub-items you haven't reordered still fall back to start date as before.",
      },
    ],
  },
  {
    version: "2.161.11",
    date: "2026-07-10",
    title: "Your name shows up right away on comments you post",
    highlights: [
      {
        kind: "fix",
        text: "When you commented on an issue, the comment briefly showed \"Unknown\" as the author until the page was reloaded. Your name and avatar now appear immediately on comments you post.",
      },
    ],
  },
  {
    version: "2.161.10",
    date: "2026-07-10",
    title: "Clearer message when a feedback edit can't be saved",
    highlights: [
      {
        kind: "fix",
        text: "If saving an edit to your feature request or bug report is rejected, the feedback board now shows the specific reason (for example, that only the author can edit an item) instead of a generic \"couldn't save\" error, so it's clear what went wrong.",
      },
    ],
  },
  {
    version: "2.161.9",
    date: "2026-07-10",
    title: "Analytics no longer crashes when a section has no data yet",
    highlights: [
      {
        kind: "fix",
        text: "The Analytics page could crash to a blank screen when the Feedback or Project Detail tab loaded a section with missing or not-yet-populated data. Those tabs now fall back to a clean empty state instead of erroring, so the page always renders.",
      },
    ],
  },
  {
    version: "2.161.7",
    date: "2026-07-10",
    title: "Edit a feature request or bug report after you've filed it",
    highlights: [
      {
        kind: "fix",
        text: "You can now edit the title and details of a feature request or bug report you submitted — open it from the feedback board and use the pencil to update or the trash to remove it. Editing your own item no longer needs admin rights, and admins keep control of triage (status changes) without being able to rewrite someone else's words.",
      },
    ],
  },
  {
    version: "2.161.6",
    date: "2026-07-10",
    title: "New RAID log entries start in a real category instead of 'Unclassified'",
    highlights: [
      {
        kind: "improvement",
        text: "Creating an issue from the RAID log now lets you pick its category — Risk, Assumption, Issue, or Dependency — right in the New issue dialog, defaulting to Risk, so a new entry lands in the right column instead of piling up under 'Unclassified'. Reclassifying existing entries by dragging a card between columns (or via the card's 'Categorize' menu) continues to work and persists.",
      },
    ],
  },
  {
    version: "2.161.5",
    date: "2026-07-10",
    title: "Deleting several issues at once is reliable and tells you if anything is left behind",
    highlights: [
      {
        kind: "fix",
        text: "Bulk-deleting issues no longer stops at a dead-end 'Couldn't delete the selected items.' On the Issues list, a delete that spans several projects now removes every item it can and, if one project can't be deleted, tells you how many were left and why instead of failing the whole batch. On boards, a failed delete now shows the real reason rather than a generic error.",
      },
    ],
  },
  {
    version: "2.161.4",
    date: "2026-07-10",
    title: "Assigning a parent no longer jumps you away from the issue you're editing",
    highlights: [
      {
        kind: "fix",
        text: "When you set (or change) an issue's parent from its detail panel, the panel now stays on that issue instead of flipping over to the parent. The parent's sub-item list still picks up the child immediately — the relationship stays in sync both ways, with no refresh.",
      },
    ],
  },
  {
    version: "2.161.3",
    date: "2026-07-10",
    title: "Bulk-tagging respects a 'select all matching' selection across pages",
    highlights: [
      {
        kind: "fix",
        text: "On the Issues list, adding a tag to a cross-page 'Select all N matching' selection now tags every matching issue — not just the ones on the current page. Bulk assign, priority, and delete already spanned the whole selection; tagging now does too.",
      },
    ],
  },
  {
    version: "2.161.2",
    date: "2026-07-10",
    title: "Release Timeline keeps tickets aligned with their bars while scrolling",
    highlights: [
      {
        kind: "fix",
        text: "On the Release Timeline (Gantt), scrolling down now moves the ticket list and the timeline together, so each ticket stays lined up with its bar — the two panes can no longer drift apart, whatever you scroll with.",
      },
    ],
  },
  {
    version: "2.161.1",
    date: "2026-07-10",
    title: "Push notifications enable correctly after you click 'Allow'",
    highlights: [
      {
        kind: "fix",
        text: "Enabling push notifications now works: after you grant the browser permission, the app completes the subscription instead of wrongly reporting that notifications couldn't be enabled.",
      },
    ],
  },
  {
    version: "2.161.0",
    date: "2026-07-09",
    title: "Who reported it, and autonomous delivery goes continuous",
    highlights: [
      {
        kind: "feature",
        text: "Every feedback item now shows who reported it, and that reporter is carried onto the work item it's triaged into — so you can see the source of a request right on the issue.",
      },
      {
        kind: "improvement",
        text: "Autonomous delivery now opens a pull request for every change it makes — auto-merging safe ones and leaving risky ones for review — and links that PR on the ticket, so there's a full trail of what shipped and why.",
      },
    ],
  },
  {
    version: "2.160.5",
    date: "2026-07-09",
    title: "PM Dashboard crash fixed",
    highlights: [
      {
        kind: "fix",
        text: "The project PM Dashboard no longer crashes on load for people outside the UTC timezone — milestone and deliverable dates now show the same calendar day everywhere.",
      },
    ],
  },
  {
    version: "2.160.4",
    date: "2026-07-09",
    title: "Feedback automation checkboxes stick",
    highlights: [
      {
        kind: "fix",
        text: "Autonomous-delivery project selections now survive navigating away and back — the save is reflected in the page immediately instead of briefly reverting to the previous selection.",
      },
    ],
  },
  {
    version: "2.160.3",
    date: "2026-07-08",
    title: "Feedback automation settings unblocked",
    highlights: [
      {
        kind: "fix",
        text: "When every project an automation targeted has left the org, it's now shown as off (instead of on-but-empty) — which was quietly blocking all edits on that settings page, including the other card's checkboxes.",
      },
    ],
  },
  {
    version: "2.160.2",
    date: "2026-07-08",
    title: "Feedback automation settings fixes",
    highlights: [
      {
        kind: "fix",
        text: "Autonomous delivery project checkboxes now save immediately — checking or unchecking a project sticks, instead of quietly reverting.",
      },
      {
        kind: "fix",
        text: "Feedback automation settings no longer get stuck when a project referenced by the config leaves the org (moved or deleted) — the stale reference is dropped automatically instead of blocking every save.",
      },
    ],
  },
  {
    version: "2.160.1",
    date: "2026-07-08",
    title: "Feedback automation, clarified",
    highlights: [
      {
        kind: "improvement",
        text: "The Feedback automation settings now spell out what they do: auto-triage routes this org's feedback into the board(s) you choose (set a default to funnel everything to one board), and autonomous delivery is marked as an owner-level capability.",
      },
    ],
  },
  {
    version: "2.160.0",
    date: "2026-07-08",
    title: "Feedback automation, per project",
    highlights: [
      {
        kind: "feature",
        text: "Auto-triage now delivers feedback into whichever project it's about — pick one or more target projects, plus a default for anything unrouted, in Settings → Feedback automation.",
      },
      {
        kind: "feature",
        text: "Feature requests and bug reports are now tagged with their project as they come in, so each lands in the right backlog instead of one shared inbox.",
      },
    ],
  },
  {
    version: "2.158.0",
    date: "2026-07-07",
    title: "What's new, in-app",
    highlights: [
      {
        kind: "feature",
        text: "This — a \"What's new\" note that pops once per release to catch you up. Reopen it any time from the account menu.",
      },
    ],
  },
  {
    version: "2.157.0",
    date: "2026-07-07",
    title: "Smarter, safer feedback automation",
    highlights: [
      {
        kind: "improvement",
        text: "Auto-triage now runs on your own connected Claude subscription and won't act without one — so tickets it files reflect real AI triage, never a low-signal guess.",
      },
      {
        kind: "feature",
        text: "Opt-in coding agent can draft fixes for triaged tickets as draft pull requests for your review — it never merges or deploys on its own.",
      },
    ],
  },
  {
    version: "2.156.0",
    date: "2026-07-07",
    title: "Feedback → backlog, automatically",
    highlights: [
      {
        kind: "feature",
        text: "New feature requests and bug reports are AI-classified (type, severity, effort, acceptance criteria) and delivered into your target project's backlog — hourly, so nothing sits in the inbox.",
      },
    ],
  },
  {
    version: "2.155.0",
    date: "2026-07-07",
    title: "Epic types & smoother imports",
    highlights: [
      {
        kind: "improvement",
        text: "Classify epics as Business or Enabler with the new Epic Type field (shown only on epics).",
      },
      {
        kind: "fix",
        text: "Importing tickets that reference sprints which don't exist yet now clearly creates those sprints — with an upfront \"N new sprints will be created\" callout.",
      },
    ],
  },
  {
    version: "2.154.0",
    date: "2026-07-07",
    title: "Gantt analysis lenses",
    highlights: [
      {
        kind: "feature",
        text: "Set a baseline and see planned-vs-actual on the Gantt — a ghost track behind each bar with slippage called out in red.",
      },
      {
        kind: "feature",
        text: "New Gantt lenses: Critical path, Baselines, and an Enabler overlay that distinguishes enabler work from business value.",
      },
    ],
  },
  {
    version: "2.153.0",
    date: "2026-07-07",
    title: "OKRs meet the work",
    highlights: [
      {
        kind: "feature",
        text: "Link key results to tickets and auto-roll-up key-result progress from the linked work.",
      },
    ],
  },
  {
    version: "2.152.0",
    date: "2026-07-07",
    title: "Interactive dependency map",
    highlights: [
      {
        kind: "feature",
        text: "See and edit what blocks what on a live dependency map — add and remove links in place.",
      },
    ],
  },
  {
    version: "2.121.0",
    date: "2026-07-03",
    title: "OKR health over time",
    highlights: [
      {
        kind: "feature",
        text: "A stoplight health grid across check-ins plus an \"needs attention\" panel to surface objectives drifting off track.",
      },
    ],
  },
  {
    version: "2.112.0",
    date: "2026-07-01",
    title: "@-mention anything",
    highlights: [
      {
        kind: "feature",
        text: "@-mention any item — tickets, documents, people — across chat, comments, and notes, with \"Mentioned in\" backlinks.",
      },
    ],
  },
];

/** The current running version (inlined from package.json at build time). */
export const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";

/** Numeric semver compare: >0 if a>b, <0 if a<b, 0 if equal. Non-numeric or
 *  missing parts sort as 0 so a malformed value never throws. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Releases the user hasn't seen. `lastSeen === null` (never acknowledged — a
 * new browser or the rollout of this feature) → the few most-recent releases,
 * to catch them up without dumping the whole history. Otherwise every release
 * strictly newer than `lastSeen`.
 */
export function releasesSince(lastSeen: string | null): Release[] {
  if (!lastSeen) return CHANGELOG.slice(0, 3);
  return CHANGELOG.filter((r) => compareVersions(r.version, lastSeen) > 0);
}
