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
    version: "2.228.0",
    date: "2026-07-23",
    title: "Cosmo: date awareness, day-safe dates, larger action budget",
    highlights: [
      {
        kind: "fix",
        text: "Cosmo now knows the current date and time (US Eastern), so 'due tomorrow', 'by Friday', and 'end of the sprint' resolve to the right calendar date instead of a guessed one.",
      },
      {
        kind: "fix",
        text: "Fixed the off-by-one where a date you asked for (e.g. July 24) was saved as the day before — due dates, start dates, and sprint windows are now stored as whole calendar days and show the same day in every timezone.",
      },
      {
        kind: "feature",
        text: "Cosmo can set a due date and start date at creation time (not just afterward), so 'create these stories due tomorrow' lands the dates in one step.",
      },
      {
        kind: "feature",
        text: "Raised Cosmo's per-message action budget so it can carry out org- and project-wide bulk actions without stopping early; if it does hit the limit it now tells you exactly how many actions it applied and offers to continue.",
      },
      {
        kind: "improvement",
        text: "Cosmo asks before proceeding when a request is ambiguous rather than guessing or half-finishing — and when new items fall inside a sprint's dates it offers to add them to that sprint.",
      },
    ],
  },
  {
    version: "2.227.0",
    date: "2026-07-23",
    title: "Gantt: actuals shown by default, new Plan drift lens",
    highlights: [
      {
        kind: "feature",
        text: "The timeline now shows each item at its actual dates by default — solid bars colored by schedule health (green on/ahead, red slipped, amber started-late). No toggle needed to see reality.",
      },
      {
        kind: "feature",
        text: "The old Actuals toggle is now Plan drift: turn it on to overlay the original planned dates as a faded ghost behind each actual bar, so you can see exactly how the schedule moved.",
      },
      {
        kind: "improvement",
        text: "Items that have already started or finished reschedule from their detail panel rather than by dragging the bar, keeping recorded actuals stable; not-yet-started items still drag on the Gantt as before.",
      },
    ],
  },
  {
    version: "2.226.0",
    date: "2026-07-23",
    title: "Gantt: resizable Work Items column + status-dropdown fix",
    highlights: [
      {
        kind: "feature",
        text: "The Work Items column on the timeline is now resizable — drag the handle on its right edge to show more or less of the name column; the width is remembered.",
      },
      {
        kind: "fix",
        text: "Fixed the status dropdown not opening when you open an item’s detail from a Gantt bar — a tap on a bar no longer holds the pointer, so the detail panel’s controls receive their clicks.",
      },
    ],
  },
  {
    version: "2.225.1",
    date: "2026-07-23",
    title: "Dependencies view: show every linked item; arrows on the actual bars",
    highlights: [
      {
        kind: "fix",
        text: "The Dependencies lens now shows EVERY linked item (built off the full item list, so a linked collapsed child no longer disappears) and refetches links when toggled so items you just linked appear without a hard refresh. Dependency arrows now connect the SOLID actual bars, not the faded planned “phantom” trails; hover/detail unchanged.",
      },
    ],
  },
  {
    version: "2.225.0",
    date: "2026-07-23",
    title: "Foreman console: split the Activity tab into Pipeline + Activity",
    highlights: [
      {
        kind: "improvement",
        text: "The long Foreman console Activity tab is split in two: a new default “Pipeline” tab for the live ticket flow (intake, up-next queue, in-flight builds, coordinated releases, awaiting-approval), and “Activity” for the browseable feeds (loop metrics, grooming suggestions, event log). Much less scrolling.",
      },
    ],
  },
  {
    version: "2.224.8",
    date: "2026-07-23",
    title: "Foreman reuses an open PR instead of failing to ship",
    highlights: [
      {
        kind: "fix",
        text: "Fixed Foreman getting stuck re-parking a ticket that had a leftover open PR from an earlier review: the deliver/merge step now REUSES (and readies) the existing PR instead of trying to create a duplicate and erroring “a pull request already exists” (e.g. COSMOS-90). Same fix applied to the coordinated-release path.",
      },
    ],
  },
  {
    version: "2.224.7",
    date: "2026-07-23",
    title: "Undo/redo for Gantt reschedules",
    highlights: [
      {
        kind: "feature",
        text: "Rescheduling items on the timeline (dragging bars or resizing edges) can now be undone and redone — Undo/Redo buttons in the toolbar plus the usual ⌘/Ctrl-Z and ⌘/Ctrl-Y (or ⌘/Ctrl-Shift-Z) shortcuts.",
      },
    ],
  },
  {
    version: "2.224.6",
    date: "2026-07-23",
    title: "Dependencies lens: focus to just the linked items, cleaner arrows",
    highlights: [
      {
        kind: "improvement",
        text: "Turning on the Dependencies lens now filters the timeline down to ONLY the items that participate in a dependency, so you focus on the interdependent set. Connectors are drawn as clean right-angle (orthogonal) elbows instead of free-form curves.",
      },
    ],
  },
  {
    version: "2.224.5",
    date: "2026-07-23",
    title: "Trace dependencies on the Gantt — without the spaghetti",
    highlights: [
      {
        kind: "feature",
        text: "New Dependencies lens on the timeline. Off by default; turn it on and hover any bar to light up just that item’s links — upstream/blockers in amber, downstream/dependents in blue — while everything unrelated fades, so you trace one chain at a time instead of a web of lines.",
      },
      {
        kind: "improvement",
        text: "The solid actual bar is now clickable to open an item’s detail (previously only the faded planned trail was).",
      },
    ],
  },
  {
    version: "2.224.4",
    date: "2026-07-23",
    title: "Gantt: actual work is the solid bar, the plan is the trail",
    highlights: [
      {
        kind: "improvement",
        text: "On the timeline the SOLID bar is now an item’s actual work at its real dates; its plan renders behind as a faded trail — red if it slipped, amber if it started late, green if on/ahead. A slip reads as the solid actual bar sitting past a faded planned trail, instead of the whole bar being outlined red.",
      },
    ],
  },
  {
    version: "2.224.3",
    date: "2026-07-23",
    title: "Gantt shows planned vs actual at real dates",
    highlights: [
      {
        kind: "improvement",
        text: "The timeline now draws each item’s actual work as a slim track at its true calendar dates beneath the planned bar — green if it finished on/ahead, red if it slipped, with an amber lead-in for the delay before a late start. A month-late item reads as its actual bar sitting a month to the right, instead of a red smear clipped at the chart’s left edge.",
      },
      {
        kind: "fix",
        text: "New items created directly in an in-progress or done column no longer auto-stamp an actual start/finish of “now” — that was backfilling misleading completion dates during board setup and import. A genuine drag-to-done move still captures the date.",
      },
    ],
  },
  {
    version: "2.224.2",
    date: "2026-07-23",
    title: "Gantt shows a late start — and when you recovered from it",
    highlights: [
      {
        kind: "improvement",
        text: "On the timeline, an item that started later than its planned start now shows an amber lead-in at the front of its bar. Paired with the finish color, a bar that starts amber but stays green reads at a glance as “started late, recovered, delivered on time.” The tooltip spells it out (e.g. “Started 7d late — recovered ✓”).",
      },
    ],
  },
  {
    version: "2.224.1",
    date: "2026-07-23",
    title: "Clearer schedule slippage on the Gantt",
    highlights: [
      {
        kind: "improvement",
        text: "On the timeline, an item that finished late (or is still open past its projected end) now shows a full-height red bar trailing to the LEFT, and one that finished early shows a green bar extending to the RIGHT — the length is how many days late or early. Replaces the thin, hard-to-read line under the bar.",
      },
    ],
  },
  { version: "2.224.0", date: "2026-07-23", title: "Coordinated release COSMOS-141", highlights: [{ kind: "feature", text: "COSMOS-141 shipped as one coordinated release spanning 2 phases (COSMOS-142, COSMOS-143), delivered together under a single version rather than a string of separate updates." }] },
  {
    version: "2.223.2",
    date: "2026-07-22",
    title: "Coordinated same-file releases now actually ship",
    highlights: [
      {
        kind: "fix",
        text: "Fixed a git plumbing bug that stopped a coordinated multi-phase release from finishing its final merge — the merge ran in a temporary worktree but referenced a fetch marker that only exists in the main checkout, so it aborted every time (safely, never a half-release). Coordinated releases whose phases touch the same file now merge and ship as one version.",
      },
    ],
  },
  {
    version: "2.223.1",
    date: "2026-07-22",
    title: "Coordinated multi-phase releases that touch the same files now ship",
    highlights: [
      {
        kind: "fix",
        text: "Foreman can now autonomously ship a coordinated release whose phases edit the same file. Phases build as a stack — each on top of the previous — so the final merge composes cleanly instead of aborting on a conflict, and the safe “no half-release” guarantee holds throughout.",
      },
      {
        kind: "improvement",
        text: "Asking Foreman to rebuild a phase now works from any board column, and a rebuild that makes a release ready re-fires the coordinated ship on its own instead of waiting for another approval.",
      },
    ],
  },
  {
    version: "2.223.0",
    date: "2026-07-22",
    title: "Schedules now show slippage on their own",
    highlights: [
      {
        kind: "feature",
        text: "Every work item, milestone, and deliverable now has one clear set of dates — Planned Start/End and Actual Start/End — and the Gantt, Schedule, and Deliverables views color themselves by whether the actual finish beat the projected date. No more “Set baseline” step.",
      },
      {
        kind: "improvement",
        text: "Actual start is captured automatically the first time an item moves into an in-progress column, and you can always correct any of the four dates from the card’s new Planned / Actual groups.",
      },
      {
        kind: "fix",
        text: "Milestone schedule variance now compares the actual date against the current projected date (it previously ignored the actual date), so slipped milestones read correctly.",
      },
    ],
  },
  {
    version: "2.222.3",
    date: "2026-07-22",
    title: "Tables no longer shake on hover",
    highlights: [
      {
        kind: "fix",
        text: "Fixed a jitter where hovering near the boundary between two rows in a table (Deliverables and other data tables) made the row flicker/shake rapidly. The hover highlight no longer nudges the layout.",
      },
    ],
  },
  {
    version: "2.222.2",
    date: "2026-07-21",
    title: "A cleaner “What’s new” dialog",
    highlights: [
      {
        kind: "fix",
        text: "Opening “What’s new” no longer shows a stray highlight ring around the release notes — focus now lands on the button, so you can dismiss it in one click.",
      },
    ],
  },
  {
    version: "2.222.0",
    date: "2026-07-21",
    title: "The Foreman console is easier to navigate",
    highlights: [
      {
        kind: "improvement",
        text: "The Foreman console is now organized into tabs \u2014 Activity, Connections, Build behavior, and Automation \u2014 so you land on what Foreman is doing and find configuration where you expect it. Each tab is deep-linkable.",
      },
      {
        kind: "improvement",
        text: "Adding a skill is now one form: compose it with fields, or switch to Paste to drop in a SKILL.md and review the parsed fields before saving \u2014 no more separate create and import.",
      },
    ],
  },
  {
    version: "2.221.0",
    date: "2026-07-21",
    title: "See how reliably Foreman is delivering",
    highlights: [
      {
        kind: "feature",
        text: "The Foreman console has a new \"Delivery convergence\" card: convergence rate, iterations to converge, invariant-violation rate, and cost per convergence \u2014 computed from a durable, replayable record of every build loop. It answers \"is Foreman getting better or worse at shipping?\" at a glance.",
      },
      {
        kind: "improvement",
        text: "Behind the scenes: in shadow mode Foreman now measures whether its convergence logic agrees with what the build daemon actually does, so we can trust it before it ever drives builds itself.",
      },
    ],
  },
  {
    version: "2.220.0",
    date: "2026-07-20",
    title: "Groundwork for a self-monitoring build engine",
    highlights: [
      {
        kind: "improvement",
        text: "Behind the scenes: Foreman now keeps a durable, replayable record of each ticket's build loop. There is no user-facing change yet -- it quietly observes what the build engine does so we can measure and improve delivery reliability over time.",
      },
    ],
  },
  {
    version: "2.219.1",
    date: "2026-07-20",
    title: "Screen readers can find the notifications bell",
    highlights: [
      {
        kind: "fix",
        text: "The notifications bell in the top bar now has an accessible name, so screen readers announce it as “Notifications” (including your unread count when you have unread items).",
      },
    ],
  },
  {
    version: "2.219.0",
    date: "2026-07-20",
    title: "Foreman build agents are now project- and org-aware",
    highlights: [
      {
        kind: "feature",
        text: "Foreman\u2019s build agents now load project Skills, a project system prompt, in-app tools, and safety guardrails on every build \u2014 so they follow this codebase\u2019s conventions instead of re-deriving them each time. Manage it all from the console: create or import Skills, add remote (https) MCP tool servers, and set a per-org system-prompt addition, with a per-org on/off. Ships with a starter set of cosmos-v2 skills.",
      },
    ],
  },
  {
    version: "2.218.1",
    date: "2026-07-20",
    title: "Supervisor status right on the ticket",
    highlights: [
      {
        kind: "improvement",
        text: "A work item\u2019s detail panel now shows the Foreman supervisor\u2019s latest take on that ticket \u2014 close-as-delivered, requeue, dedup, or escalate \u2014 with an Apply button for dry-run proposals and Undo for actions already taken, without leaving the ticket.",
      },
    ],
  },
  {
    version: "2.218.0",
    date: "2026-07-20",
    title: "Foreman supervisor: apply and undo from the console, fully UI-configured",
    highlights: [
      {
        kind: "improvement",
        text: "The Foreman supervisor is now driven entirely from the console — no environment variables. In the activity feed you can Apply a dry-run proposal to act on it, or Undo a live action (it reopens the PR and moves the card back). The settings card now explains what every option does — the three modes, each grooming behavior, and the confidence/limit knobs.",
      },
    ],
  },
  {
    version: "2.217.0",
    date: "2026-07-19",
    title: "Foreman supervisor: configurable self-grooming for the board",
    highlights: [
      {
        kind: "feature",
        text: "Foreman now has a supervisor that grooms the parked side of the board — it can close drafts already delivered on main, re-queue builds that failed on since-fixed issues, flag duplicates, and escalate questions to you. Configure it per-org from the Foreman console (off / dry-run / live, plus per-behavior toggles), and watch what it does in the new Supervisor activity feed. Ships in dry-run so it only proposes, never changes anything, until you switch it to live.",
      },
    ],
  },
  {
    version: "2.216.4",
    date: "2026-07-19",
    title: "Feedback Automation points you to the right Claude setup",
    highlights: [
      {
        kind: "fix",
        text: "The Feedback Automation ‘connect a Claude subscription’ notice now links to the Foreman connect page — where the triage Claude actually lives — instead of Settings → AI, and the copy reads ‘Connect Claude for Foreman.’",
      },
    ],
  },
  {
    version: "2.216.3",
    date: "2026-07-19",
    title: "Foreman’s approval recommendations now judge the whole change",
    highlights: [
      {
        kind: "fix",
        text: "The Foreman console’s per-item AI Analysis used to see only the first part of a larger pull request and then flag the hidden remainder as a “gap,” recommending Rework even when every acceptance criterion was met. It now condenses the diff so every changed line is included, never counts an omission against the change, and recommends Approve when the work satisfies the ticket with passing checks.",
      },
    ],
  },
  {
    version: "2.216.2",
    date: "2026-07-19",
    title: "Sidebar toggle now reads clearly to screen readers",
    highlights: [
      {
        kind: "fix",
        text: "The sidebar collapse/expand button now has an accessible name that reflects its action and state — screen readers announce “Collapse sidebar” or “Expand sidebar” instead of just “Button”.",
      },
    ],
  },
  {
    version: "2.216.1",
    date: "2026-07-19",
    title: "Empty Kanban columns no longer look broken",
    highlights: [
      {
        kind: "fix",
        text: "A project board column with no cards now shows a subtle, centered “No items” placeholder instead of appearing empty and broken.",
      },
    ],
  },
  {
    version: "2.216.0",
    date: "2026-07-18",
    title: "Foreman authenticates to GitHub with your connected token",
    highlights: [
      {
        kind: "improvement",
        text: "When a GitHub token is connected in Foreman settings, the delivery daemon now uses it for all of its git and pull-request work (fetch, push, open, merge) instead of the host GitHub CLI login. To let Foreman merge its own PRs, the token needs Contents and Pull requests write plus Administration; the settings card lists exactly what to grant.",
      },
    ],
  },
  {
    version: "2.215.0",
    date: "2026-07-18",
    title: "In-app guidance for the Foreman GitHub token",
    highlights: [
      {
        kind: "improvement",
        text: "The GitHub-for-Foreman card now spells out exactly how to create the token and which repository permissions to grant (Pull requests, Contents, and optional Checks/Actions), so you can set it up without leaving the page.",
      },
    ],
  },
  {
    version: "2.214.0",
    date: "2026-07-18",
    title: "Connect GitHub for Foreman's PR analysis",
    highlights: [
      {
        kind: "feature",
        text: "You can now connect a GitHub token for Foreman in the console, alongside its Claude subscription. Foreman uses it to read pull requests for the AI analysis and Approve/Rework recommendations. Paste a fine-grained, read-only token; it is validated and stored encrypted. Until one is connected, those panels correctly say they couldn't analyze the PR.",
      },
    ],
  },
  {
    version: "2.213.0",
    date: "2026-07-17",
    title: "Watch Foreman work in real time",
    highlights: [
      {
        kind: "improvement",
        text: "The Foreman console now shows what the delivery agent is doing as it happens: the in-flight ticket's phase (building, checks, repair, review, shipping) and its live progress update the instant they change, with no refresh. Large tickets that need more than one work session show their segment and elapsed time, so you can watch steady progress.",
      },
    ],
  },
  {
    version: "2.212.0",
    date: "2026-07-17",
    title: "Reset a forgotten password",
    highlights: [
      {
        kind: "feature",
        text: "Forgot your password? There's now a \"Forgot password?\" link on the sign-in screen for email & password accounts: we email you a secure link that expires in an hour and can be used once to set a new password. Admins and owners can also send a reset link to a teammate from the Team page. People who sign in with Google or SSO don't have a password to reset, and are told so clearly.",
      },
    ],
  },
  {
    version: "2.211.2",
    date: "2026-07-17",
    title: "Boards move in real time during automated delivery",
    highlights: [
      {
        kind: "improvement",
        text: "Your project board now updates live while Foreman works a ticket. Cards move through the columns — In Progress, Review, Done — the moment the daemon advances them, with no manual refresh.",
      },
    ],
  },
  {
    version: "2.210.1",
    date: "2026-07-16",
    title: "Settings & membership update live",
    highlights: [
      {
        kind: "improvement",
        text: "Settings now update in real time. When an admin changes organization settings, feedback automation and intake policy, a member's role, or their work-role assignments, every other open Settings view refreshes the instant it happens — no manual reload — so two admins working at once always see the same, current configuration.",
      },
    ],
  },
  {
    version: "2.208.1",
    date: "2026-07-16",
    title: "The Foreman console updates live",
    highlights: [
      {
        kind: "improvement",
        text: "The Foreman console now updates in real time. Approving, Reworking, or Rebuilding a parked ticket — and the build-status moves that follow — refresh the Awaiting-approval, In-flight, and event lists the instant they happen, and the change also shows up on the board, with no manual refresh and no waiting on a poll.",
      },
    ],
  },
  {
    version: "2.206.1",
    date: "2026-07-16",
    title: "Epics ship as one coordinated release",
    highlights: [
      {
        kind: "feature",
        text: "Large feature epics are now automatically split into ordered phases before building, and those phases ship together as ONE coordinated release — a single version, tag, and changelog entry in dependency order — instead of a string of separate updates. If any phase can't complete, the whole release holds rather than going out half-finished. Small, incremental tickets are unaffected and still ship on their own.",
      },
      {
        kind: "improvement",
        text: "The Foreman console now shows each coordinated epic's phase readiness — how many phases are ready, pending, or failed, and whether the release is holding, shipping, or blocked.",
      },
    ],
  },
  {
    version: "2.206.0",
    date: "2026-07-16",
    title: "Duplicate/scope intake checks + self-updating delivery daemon",
    highlights: [
      { kind: "feature", text: "Feedback intake now detects near-duplicate requests and links them to the existing item (merging votes) instead of opening a second ticket, and routes out-of-scope or decision-required feedback to a human instead of the automated build queue. Nonsense is rejected." },
      { kind: "improvement", text: "The autonomous delivery daemon now restarts itself after shipping a change to its own code, so fixes to the delivery pipeline take effect immediately instead of waiting for a manual restart." },
    ],
  },
  {
    version: "2.205.0",
    date: "2026-07-15",
    title: "On-demand AI analysis of pending changes + smarter release versioning",
    highlights: [
      {
        kind: "feature",
        text: "Each item awaiting approval now has an AI Analysis action that checks the built change against the original ticket's requirements and acceptance criteria, returning a per-criterion met/partial/missing report with gaps and risks, cached per revision. Items with no built change disable the action.",
      },
      {
        kind: "improvement",
        text: "Automatic release versioning now follows SemVer intent even when a change has to be rebased before merging: feature work bumps the minor version and bug fixes bump the patch version, instead of defaulting everything to a patch.",
      },
    ],
  },
  {
    version: "2.204.8",
    date: "2026-07-15",
    title: "Reliable delivery of multi-phase changes",
    highlights: [
      {
        kind: "improvement",
        text: "When a large feature or fix is split into several linked tickets, approving them one after another now just works. If a later phase was built before an earlier one shipped, the system automatically rebases it onto the latest code and re-numbers the release before merging, instead of stalling on a merge conflict that previously needed a manual rebuild and re-approval. Linked phases can also be grouped into one coordinated release so an epic ships as a single version rather than a string of patches.",
      },
    ],
  },
  {
    version: "2.204.6",
    date: "2026-07-15",
    title: "Human triage for lower-trust feedback",
    highlights: [
      {
        kind: "improvement",
        text: "Automatic feedback triage now considers who filed a request before building it. Feedback from lower-trust roles — guests and view-only members — is routed to a teammate for a quick human look first, instead of flowing straight into the automated build queue; ordinary members and above are unaffected. The person who filed it is notified that a teammate will review it, every decision is recorded in the audit log, and which roles are allowed to auto-trigger a build is configurable per organization.",
      },
    ],
  },
  {
    version: "2.204.5",
    date: "2026-07-15",
    title: "Fair-share limits on automatic feedback triage",
    highlights: [
      {
        kind: "improvement",
        text: "Automatic feedback triage now shares the build queue fairly. Per-person and per-organization limits, an overall queue-depth ceiling, and a build-capacity budget keep any single flurry of requests from monopolizing the automated builders — and re-filing the same request over and over is recognized and collapsed instead of piling up. Anything held back stays open and is picked up automatically as capacity frees, and the person who filed it sees a clear note that their request is queued. Normal-volume feedback is unaffected.",
      },
    ],
  },
  {
    version: "2.204.4",
    date: "2026-07-15",
    title: "Sharper eye on risky feedback",
    highlights: [
      {
        kind: "improvement",
        text: "The feedback safety gate now has a second, smarter layer. After the fast automatic checks, a security reviewer takes a closer look at anything that would otherwise be auto-built, so cleverly disguised attempts to manipulate the coding agent or sneak in sabotaging changes get caught and routed to a human instead. It only ever adds caution — it can hold a request for review but never waves one through that the first checks stopped — and if it's ever unavailable your feedback keeps flowing exactly as before. Ordinary requests are unaffected.",
      },
    ],
  },
  {
    version: "2.204.3",
    date: "2026-07-15",
    title: "Safer feedback intake before auto-triage",
    highlights: [
      {
        kind: "improvement",
        text: "Feedback now passes a safety gate before it can be auto-triaged into the backlog. Submissions that try to manipulate the coding agent, ask for destructive or sabotaging changes, touch high-risk areas (auth, billing, secrets, dependencies), or paste in a secret are routed to a human reviewer instead of being built automatically — and unsafe content is declined. If your request is held or declined you'll get a notification explaining why, and every intake decision is recorded in the audit log.",
      },
    ],
  },
  {
    version: "2.204.2",
    date: "2026-07-14",
    title: "AI approval recommendations in the Foreman console",
    highlights: [
      {
        kind: "feature",
        text: "Every card in the Foreman console's Awaiting-approval list now shows an AI recommendation — Approve, Rework, or Rebuild — with a one-line rationale. For a built change, Foreman reviews the actual pull request (its diff, CI results, and why it was parked) and tells you whether it's ready to ship; for an item that never produced a PR, it recommends Rebuild because there's nothing to approve.",
      },
    ],
  },
  {
    version: "2.204.1",
    date: "2026-07-14",
    title: "Clearer Foreman console controls",
    highlights: [
      {
        kind: "improvement",
        text: "Every button in the Foreman console now has a hover tooltip spelling out exactly what it does, and every action that changes state asks you to confirm first. Approve's confirmation makes it unmistakable that it merges the PR and deploys to live production (health-gated, with automatic rollback).",
      },
      {
        kind: "improvement",
        text: "Rework and Rebuild are no longer ambiguous: Rework resumes the existing build with your guidance, while Rebuild throws the current build away and starts fresh — the labels, tooltips, and confirmations now say so plainly. The \"Open PR\" button is now labeled \"Link to PR\" to make clear it just opens the pull request read-only.",
      },
    ],
  },
  {
    version: "2.204.0",
    date: "2026-07-14",
    title: "Re-add teammates cleanly, and offboard for real",
    highlights: [
      {
        kind: "improvement",
        text: "Re-inviting someone who already has an account just works now — instead of an error, they're added back to the team the next time they sign in (with whatever login they already use). No need to guess which sign-in method to pick.",
      },
      {
        kind: "feature",
        text: "Platform admins can permanently offboard a user account: it revokes access across every organization and frees the email to be invited fresh, while the person's past work is preserved (shown as \"Deleted user\") — nothing is orphaned.",
      },
    ],
  },
  {
    version: "2.203.0",
    date: "2026-07-13",
    title: "Send invitations from your own domain",
    highlights: [
      {
        kind: "feature",
        text: "Set up email delivery in Settings → Organization: connect Resend with your verified domain, and invitations send from your own branded address (e.g. invites@yourdomain.com) instead of the inviter's personal Gmail — so they reach the inbox instead of spam. Includes a one-click \"Send test\" to confirm delivery before you turn it on.",
      },
    ],
  },
  {
    version: "2.202.1",
    date: "2026-07-13",
    title: "Your theme follows you, not the browser",
    highlights: [
      {
        kind: "fix",
        text: "Your theme (\"skin\") is now saved to your account instead of just the browser — so it follows you across devices, and a freshly-invited teammate signing in on a shared computer gets the organization's default theme instead of inheriting the previous person's.",
      },
    ],
  },
  {
    version: "2.202.0",
    date: "2026-07-13",
    title: "Invite teammates by email + password",
    highlights: [
      {
        kind: "feature",
        text: "Invite teammates with either single sign-on (Google/Microsoft) or an email + password. Email/password invitees receive a one-time temporary password with their invite and must set their own at first sign-in.",
      },
      {
        kind: "feature",
        text: "Require multi-factor authentication per invite — the invitee is walked through MFA enrollment on first sign-in, before they reach the app.",
      },
    ],
  },
  {
    version: "2.201.0",
    date: "2026-07-13",
    title: "A sharper Cosmo chat",
    highlights: [
      {
        kind: "improvement",
        text: "Conversations name themselves. After your first exchange, Cosmo titles the chat with a short summary — no more a sidebar full of \"New conversation.\"",
      },
      {
        kind: "fix",
        text: "Tool-call steps no longer spin forever. Finished steps show as done — including when you reopen an earlier conversation.",
      },
      {
        kind: "feature",
        text: "When Cosmo creates or updates something — a work item, note, meeting, or project — it now appears in the chat as a clickable card that takes you straight to it.",
      },
    ],
  },
  {
    version: "2.200.1",
    date: "2026-07-13",
    title: "Foreman connections now power the daemon",
    highlights: [
      {
        kind: "fix",
        text: "Connecting a Claude subscription for Foreman now actually drives autonomous delivery. The connection saved correctly, but the daemon couldn't use it — so builds stayed parked and the console read \"not responding.\" Fixed: a freshly connected Foreman starts working right away.",
      },
    ],
  },
  {
    version: "2.200.0",
    date: "2026-07-13",
    title: "Foreman gets its own Claude connection — plus a sharper assistant",
    highlights: [
      {
        kind: "feature",
        text: "Foreman now runs on its own dedicated Claude subscription. Connect it on the Foreman console — separate from your organization and personal AI connections — so autonomous delivery keeps running on its own capacity.",
      },
      {
        kind: "improvement",
        text: "The Cosmo assistant now knows who it's talking to, so \"assign this to me\" just works, and it resolves projects by loose name — say \"VITL BMA\" and it maps to your VITL project.",
      },
      {
        kind: "feature",
        text: "Organization owners can raise their data classification in Settings → Organization; lowering it (which relaxes AI content controls) stays with platform administrators.",
      },
    ],
  },
  {
    version: "2.199.1",
    date: "2026-07-12",
    title: "Refining a parked build no longer discards it",
    highlights: [
      {
        kind: "fix",
        text: "A comment that only mentions rebuilding in passing — like “tweak the copy, no need to rebuild everything” or “let's not start over, just fix the header” — now resumes Foreman's parked build with your instructions instead of throwing it away and starting from scratch. Rebuild only fires when the whole comment is the command itself (“rebuild”, “start over”, “please rebuild”).",
      },
    ],
  },
  {
    version: "2.199.0",
    date: "2026-07-12",
    title: "Foreman plans its own queue — and takes rework orders",
    highlights: [
      {
        kind: "feature",
        text: "To-do is now Foreman's curated \"up next\" queue: a planner pass promotes the highest-priority backlog tickets (weighing votes, severity, bugs vs features, and age) with a visible one-line why. Move a ticket out of To-do and Foreman respects the demotion until the ticket changes (or a week passes). Foreman console: new Up-next section shows the planned queue in claim order; parked builds gain a Rework button — type follow-up instructions and Foreman resumes the same session.",
      },
      {
        kind: "fix",
        text: "Tickets placed in To-do were never actually claimed; Approve now lights up on builds parked before v2.198.",
      },
    ],
  },
  {
    version: "2.198.0",
    date: "2026-07-12",
    title: "Talk to Foreman on its tickets",
    highlights: [
      {
        kind: "feature",
        text: "Comment “approve” (or “lgtm”, “ship it”) on a parked Foreman ticket to merge its pull request right away — deploy follows on the next pass, and no @Foreman mention is needed since a comment on a parked ticket is already talking to it. Any other comment resumes the exact same working session against that PR instead of starting over, and “rebuild” discards the attempt for a fresh one — the Foreman console's review cards now have a one-click “Approve” button to match.",
      },
    ],
  },
  {
    version: "2.197.0",
    date: "2026-07-12",
    title: "Assign every role from the Team page",
    highlights: [
      {
        kind: "feature",
        text: "Each member's row on the Team page now shows their base role plus chips for every work role they hold, so you can see everyone's access at a glance. A new Manage roles dialog sets both the base tier and any built-in or custom roles in one place — no more hopping over to Roles & Access to grant a single role.",
      },
    ],
  },
  {
    version: "2.195.0",
    date: "2026-07-11",
    title: "Roles you can start with",
    highlights: [
      {
        kind: "feature",
        text: "Every org now ships with eight ready-made work roles — Project Manager, Contributor, Reviewer, Operations, Finance, Analyst, Client, and Compliance — so you can assign sensible permissions from day one instead of building roles from scratch. The Roles & Access page now shows the exact permissions behind every role, including the base org roles, and any role can be cloned into a new custom one to fine-tune.",
      },
    ],
  },
  {
    version: "2.193.0",
    date: "2026-07-11",
    title: "Bigger profile pictures, clearer guidance",
    highlights: [
      {
        kind: "improvement",
        text: "You can now upload a full-size profile photo — pick anything up to 25MB and we resize it for you automatically. The uploader used to say “up to 200KB”, which turned people away from photos that would actually have worked fine.",
      },
    ],
  },
  {
    version: "2.192.0",
    date: "2026-07-11",
    title: "Timeline dates stay put while you scroll",
    highlights: [
      {
        kind: "fix",
        text: "On the Timeline (Gantt) board, the date row now stays pinned to the top while you scroll down through the chart — so you can always tell which dates the bars line up with. It used to slip out of view after the first screenful.",
      },
    ],
  },
  {
    version: "2.191.0",
    date: "2026-07-11",
    title: "Calmer chat timestamps",
    highlights: [
      {
        kind: "improvement",
        text: "Chat and DM timestamps now read to the minute instead of the second, and they no longer repeat on every message — you'll see a time on the first message of the day and again after a few hours of quiet, so a quick back-and-forth stays clean. Need the exact time on a specific message? Just click it to reveal the full timestamp, down to the second.",
      },
    ],
  },
  {
    version: "2.190.1",
    date: "2026-07-11",
    title: "Foreman gets a hard hat",
    highlights: [
      {
        kind: "improvement",
        text: "Foreman traded the robot icon for a hard hat — a flat, modern glyph on its ticket-comment avatar and across the console, sidebar, dashboard card, and settings.",
      },
    ],
  },
  {
    version: "2.190.0",
    date: "2026-07-11",
    title: "“Assigned to me” on the backlog",
    highlights: [
      {
        kind: "feature",
        text: "The Backlog board now has the same one-click “Assigned to me” toggle as your Sprint and Kanban boards — press it to narrow the whole planner down to just your items, press it again to bring everything back. It works alongside “Hide done”, and the button lights up while it's active so you always know what you're looking at.",
      },
    ],
  },
  {
    version: "2.189.0",
    date: "2026-07-11",
    title: "Foreman gets a cockpit",
    highlights: [
      {
        kind: "feature",
        text: "Autonomous delivery now has a home: a dedicated Foreman console shows live status, what's building right now, and lets you approve or requeue anything parked for review — plus a quick-glance pulse card right on your dashboard. If the daemon ever goes quiet, a watchdog alert lets you know.",
      },
    ],
  },
  {
    version: "2.188.0",
    date: "2026-07-11",
    title: "Drill into your Sprint Dashboard by assignee",
    highlights: [
      {
        kind: "feature",
        text: "On the Sprint Dashboard, the Assignee Workload chart is now clickable — click a teammate's bar to see the exact tickets making up their workload, then close it to jump right back to the dashboard. This rounds out drill-down across the whole dashboard, alongside the metric cards and the status and priority charts.",
      },
    ],
  },
  {
    version: "2.187.0",
    date: "2026-07-11",
    title: "Admins can edit any feedback item",
    highlights: [
      {
        kind: "improvement",
        text: "On the feedback board, admins can now edit the title and details of any feature request or bug report — not just triage its status or delete it. You still see who submitted each item (\"Reported by …\"), and regular members can still edit and delete only the items they filed. All of this is enforced on the server, so no one can change someone else's feedback without permission.",
      },
    ],
  },
  {
    version: "2.186.0",
    date: "2026-07-11",
    title: "Select and move several cards at once",
    highlights: [
      {
        kind: "feature",
        text: "On a board you can now grab several cards at once and move, assign, re-prioritize, or delete them together. Cmd/Ctrl-click cards to pick them one by one, or click one card and Shift-click another to select the whole run in between — great for clearing out a long \"To do\" column. Selected cards are highlighted, and clicking an empty part of the board clears the selection.",
      },
    ],
  },
  {
    version: "2.185.1",
    date: "2026-07-11",
    title: "Steadier issues table on right-click",
    highlights: [
      {
        kind: "fix",
        text: "Right-clicking a row in the Issues table (or any data table) to open its actions menu no longer jerks the list up or down — the rows stay exactly where they were while the menu opens and after it closes.",
      },
    ],
  },
  {
    version: "2.185.0",
    date: "2026-07-11",
    title: "Search the assignee picker too",
    highlights: [
      {
        kind: "feature",
        text: "Assigning people to an issue is now a type-to-filter search, matching the parent-issue picker — open the Assignees dropdown on an issue and start typing a name or email to narrow a long member list instead of scrolling. You can still pick several people (the first stays the primary assignee), the popup stays open as you check them off, and clearing the box brings everyone back. Handy for orgs with lots of members.",
      },
    ],
  },
  {
    version: "2.184.1",
    date: "2026-07-11",
    title: "Clearer feedback screenshot uploads",
    highlights: [
      {
        kind: "fix",
        text: "Attaching a screenshot to feedback now tells you exactly what went wrong when an upload fails — too large, unsupported file type, rate-limited, or a connection problem — instead of a blanket “Couldn't upload”. Screenshots with spaces and colons in the name (like the default macOS “Screenshot … at 2:27 PM.png”) upload reliably, and failures are now logged with their reason so they're easier to track down.",
      },
    ],
  },
  {
    version: "2.184.0",
    date: "2026-07-11",
    title: "Duplicate an issue into an editable draft",
    highlights: [
      {
        kind: "feature",
        text: "Duplicating an issue from the Issues list now opens a pre-filled “Duplicate issue” draft — title, description, labels, priority, assignees, type, and more copied from the original — so you can tweak just what's different before creating. Saving makes a brand-new issue with its own ID; comments, activity, and status are never carried over. Great for filing lots of similar tickets without retyping.",
      },
    ],
  },
  {
    version: "2.183.0",
    date: "2026-07-11",
    title: "Tune autonomous delivery's parallelism from Settings",
    highlights: [
      {
        kind: "feature",
        text: "Settings → Feedback automation now has a Parallel builds control (1-3) for how many tickets autonomous delivery works at once. Changes apply live — no restarts. Two is the recommended sweet spot; shipping always stays one-at-a-time for safety.",
      },
    ],
  },
  {
    version: "2.182.0",
    date: "2026-07-11",
    title: "Search your feedback, with a clearer “no results”",
    highlights: [
      {
        kind: "improvement",
        text: "A reminder that the feedback board is searchable: type in the search box to find feature requests and bug reports by title or description (and filter by type) instead of scrolling and eyeballing the list. And when a search turns up nothing, the empty message now names exactly what you searched for, so it's obvious the term simply had no matches.",
      },
    ],
  },
  {
    version: "2.181.0",
    date: "2026-07-11",
    title: "Feedback shows “In review” distinctly",
    highlights: [
      {
        kind: "improvement",
        text: "Feedback whose fix is built and waiting for a human to approve now shows as “In review” instead of “In progress” — so you can tell at a glance what's actively being worked versus what's waiting on you.",
      },
    ],
  },
  {
    version: "2.180.0",
    date: "2026-07-11",
    title: "Get a heads-up when your feedback gets picked up",
    highlights: [
      {
        kind: "feature",
        text: "When a feature request or bug report you submitted is automatically triaged into the backlog, you now get a notification — in the bell, and as a web push if you've enabled them — so you know it was seen and is being worked on without having to watch the feedback board. The alert names the ticket your feedback became and links straight back to it.",
      },
    ],
  },
  {
    version: "2.179.0",
    date: "2026-07-11",
    title: "Dependency links can't loop back on themselves anymore",
    highlights: [
      {
        kind: "improvement",
        text: "Linking work items as dependencies now refuses to create a circular dependency. If you try to add a \"blocks\" / \"blocked by\" / \"predecessor\" / \"successor\" link that would make two items each wait on the other — directly or through a longer chain (A → B → C → A) — the link is rejected with a clear message instead of quietly producing a deadlock the schedule can never resolve. Adding the exact same link twice is blocked too. \"Relates to\" and \"duplicates\" stay unrestricted since they carry no ordering, and the dependency map still flags any loops that already exist in imported data.",
      },
    ],
  },
  {
    version: "2.178.0",
    date: "2026-07-11",
    title: "The timeline remembers what you collapsed",
    highlights: [
      {
        kind: "improvement",
        text: "Collapsing an epic or story on the interactive timeline (Gantt) now sticks. Fold up a branch to focus on the big picture, then move to another board or reload the page — when you come back to the timeline, it's exactly how you left it instead of springing fully open again. The state is remembered per board for the rest of your browser session, and nested collapses are preserved: expanding an epic brings its stories back in whatever collapsed/expanded state they were in.",
      },
    ],
  },
  {
    version: "2.177.0",
    date: "2026-07-11",
    title: "Set an issue's cycle right when you create it",
    highlights: [
      {
        kind: "improvement",
        text: "The \"New issue\" dialog now lets you drop a new item straight into a cycle (sprint or Program Increment) at creation time — no need to create the issue first and then move it. The cycle picker appears whenever the selected project has cycles and stays optional, so nothing changes for the quick title-only path. This brings the dialog in line with the other creation surfaces and with what you can already edit after an issue exists: cycle, priority, assignees, and due date are all settable up front.",
      },
    ],
  },
  {
    version: "2.176.0",
    date: "2026-07-11",
    title: "Classification banners follow real DoD marking policy",
    highlights: [
      {
        kind: "improvement",
        text: "Project classification banners now render dissemination controls in the official Department of War / DoD format — the classification and its controls are joined with \"//\" and no stray spaces (e.g. \"CUI//NOFORN\" instead of \"CUI // NOFORN\"), and the full marking is announced to screen readers. Banner colors are documented against authoritative sources (the SF 703/704/705 classified cover sheets and the CUI program under DoDI 5200.48 / 32 CFR 2002): UNCLASSIFIED is green, CUI is purple, and CONFIDENTIAL is blue — red stays reserved for SECRET. FOUO remains retired in favor of CUI.",
      },
    ],
  },
  {
    version: "2.175.0",
    date: "2026-07-11",
    title: "Manage project tabs right where you see them",
    highlights: [
      {
        kind: "improvement",
        text: "Every project tab now shows a ⋯ menu right on the tab, so renaming, deleting, reordering, hiding, and setting your default view are one click away instead of hidden behind a hover. Right-click a tab for the same menu, and it's fully keyboard-accessible — closing on Escape or an outside click. Editing a board's name still needs manage permission; reordering and hiding tailor your own view and persist across reloads.",
      },
    ],
  },
  {
    version: "2.174.2",
    date: "2026-07-11",
    title: "Duplicating an item is click-safe",
    highlights: [
      {
        kind: "fix",
        text: "Duplicating a work item now behaves the same no matter how fast or how many times you click Duplicate. Rapid or repeated clicks resolve to a single, well-defined duplication instead of quietly kicking off overlapping copies — so you'll always get the \"copy the sub-items too?\" prompt when an item has sub-items, and never end up with a half-finished duplicate.",
      },
    ],
  },
  {
    version: "2.174.0",
    date: "2026-07-11",
    title: "Cosmo can now act on everything",
    highlights: [
      {
        kind: "feature",
        text: "Cosmo's toolbox grew from a handful of surfaces to full coverage of the platform: 44 new actions across OKRs (objectives, key results, check-ins, ticket links), projects, sprint updates & completion, milestones, the risk/blocker/deliverable/change registers, feedback, meetings, goals & KPIs, ticket dependencies, boards, documents, and CRM — every one permission-gated and classification-aware. Cosmo also introduces itself properly now and describes what it can do from its real tool list.",
      },
    ],
  },
  {
    version: "2.173.0",
    date: "2026-07-10",
    title: "Everything on the Release Timeline is clickable",
    highlights: [
      {
        kind: "improvement",
        text: "The Release Timeline is no longer a dead-end snapshot — every increment, deliverable, and milestone on it is now a real link. Click one to jump straight to its detail view and edit it (deliverables and milestones open their detail drawer already focused on that item), and right-click any of them for the same \"Open\" / \"Open in new tab\" menu you get elsewhere. Middle-click and ⌘/Ctrl-click open in a new tab too, so references behave consistently across every board.",
      },
    ],
  },
  {
    version: "2.172.2",
    date: "2026-07-11",
    title: "Readable in every light/dark combination",
    highlights: [
      {
        kind: "fix",
        text: "Text no longer washes out when your OS theme and your app theme disagree — ticket descriptions, triage notes, chat content, and every other dark-mode-styled element now follow the theme you picked in the app, not your operating system. If your OS was in dark mode while the app was in light mode, bold text could literally render white-on-white; that whole class of mismatch is fixed at the root.",
      },
    ],
  },
  {
    version: "2.172.1",
    date: "2026-07-11",
    title: "Voice wake-up is rock-solid",
    highlights: [
      {
        kind: "fix",
        text: "The “Hey Cosmo” microphone session no longer restarts behind the scenes while you use the app — wake-up responds reliably, and the “Listening…” pill now always turns off when you click it, even with the assistant open.",
      },
    ],
  },
  {
    version: "2.172.0",
    date: "2026-07-10",
    title: "Filter the timeline by your custom fields",
    highlights: [
      {
        kind: "improvement",
        text: "Custom fields you've defined for a project now filter the Release Timeline / Gantt too — pick a value (or flip a checkbox field on) in the filter bar and the chart narrows to matching items, exactly like filtering by sprint or assignee on the board. Custom-field filtering already worked on the Kanban board; now every board view honors it.",
      },
    ],
  },
  {
    version: "2.171.1",
    date: "2026-07-11",
    title: "\"Hey Cosmo\" hears you properly",
    highlights: [
      {
        kind: "fix",
        text: "The wake word now recognizes how speech-to-text actually hears you — \"Hey, Cosmo.\", \"hey cosmos\", even \"a cosmo\" all wake the assistant — and the chat reliably opens with the mic live, including the very first time the panel loads.",
      },
    ],
  },
  {
    version: "2.171.0",
    date: "2026-07-11",
    title: "Talk to Cosmo — hands-free",
    highlights: [
      {
        kind: "feature",
        text: "Say \"Hey Cosmo\" and the assistant opens with the mic already live — speak your message and end with \"send it\" to send it. A mic button in the chat input starts dictation any time, the input shows the live transcript while you talk, and you can set your own send phrase under Preferences → Voice send phrase.",
      },
    ],
  },
  {
    version: "2.170.0",
    date: "2026-07-10",
    title: "Search inside long dropdowns",
    highlights: [
      {
        kind: "feature",
        text: "Picking a parent issue is now a type-to-filter search instead of an endless scroll — start typing a ticket number or title and the list narrows to matches (case-insensitive) as you go, with full keyboard navigation. Clearing the box brings the whole list back. Handy on projects with hundreds of issues.",
      },
    ],
  },
  {
    version: "2.169.2",
    date: "2026-07-10",
    title: "Say \"Hey Cosmo\"",
    highlights: [
      {
        kind: "improvement",
        text: "Voice wake-up now answers to \"Hey Cosmo\" — matching your assistant's name — and the sidebar toggle and listening indicator say so. The old \"Hey COSMOS\" phrase still works.",
      },
    ],
  },
  {
    version: "2.169.0",
    date: "2026-07-10",
    title: "⌘K searches everything now",
    highlights: [
      {
        kind: "feature",
        text: "The ⌘K / Ctrl-K command palette is now a true global search: alongside projects, work items, contacts and notes, it finds documents, OKRs, goals, KPIs, boards, milestones, meetings, people, partners, products and every PM register item (risks, deliverables, blockers, change requests, CLINs) — grouped by type, keyboard-navigable, and jumping straight to whatever you pick. Type “>” for the full list of actions and quick-jumps.",
      },
    ],
  },
  {
    version: "2.168.2",
    date: "2026-07-10",
    title: "Chat opens in the slide-over, everywhere",
    highlights: [
      {
        kind: "fix",
        text: "Opening Chat from the ⌘K command palette now docks the chat slide-over in place — keeping your current page in view — instead of jumping to the old standalone chat page. The topbar, mobile nav and sidebar already did this; the command palette now matches.",
      },
    ],
  },
  {
    version: "2.168.1",
    date: "2026-07-10",
    title: "Cosmo gets a face",
    highlights: [
      {
        kind: "improvement",
        text: "Cosmo — your agentic AI chat assistant — now has its own avatar: a little astronaut waving from a starfield that re-tints live with your theme and accent color.",
      },
    ],
  },
  {
    version: "2.168.0",
    date: "2026-07-10",
    title: "Filter feedback by several statuses at once",
    highlights: [
      {
        kind: "improvement",
        text: "The Feedback list's status filter is now multi-select: tap the status chips to show, say, Open and In-progress together instead of one at a time. It combines with the Feature/Bug type filter, and a Clear button (or unticking every chip) brings back the full list.",
      },
    ],
  },
  {
    version: "2.167.0",
    date: "2026-07-10",
    title: "Meet Foreman — @-mention the delivery agent on any ticket",
    highlights: [
      {
        kind: "feature",
        text: "The autonomous delivery agent now has a face and a handle: Foreman comments on tickets as itself, and owners/admins can @-mention Foreman in a ticket's comments to steer it — give build instructions, answer its questions (it re-queues a parked ticket automatically), or just ask it something about the code and get a grounded reply.",
      },
      {
        kind: "improvement",
        text: "The chat assistant now introduces itself as Cosmo — your agentic AI chat assistant — replacing the generic \"AI Chat\" labels.",
      },
    ],
  },
  {
    version: "2.166.0",
    date: "2026-07-10",
    title: "Change an issue's status right from the list",
    highlights: [
      {
        kind: "feature",
        text: "On the Issues list you can now change a ticket's status inline — click its status and pick a new one (To Do → In Progress, etc.) without opening the board. The choices are scoped to that issue's own project, so you only ever see valid statuses, and the change saves instantly. Priority and assignee are click-to-edit here too.",
      },
    ],
  },
  {
    version: "2.165.1",
    date: "2026-07-10",
    title: "Bulk-select checkboxes no longer pop the detail drawer",
    highlights: [
      {
        kind: "fix",
        text: "Ticking an issue's checkbox to bulk-edit now just selects it — it no longer opens the single-item side drawer, so you can check several issues in a row without the drawer interrupting you. Clicking an issue's row or title still opens its details as before.",
      },
    ],
  },
  {
    version: "2.165.0",
    date: "2026-07-10",
    title: "Get notified when autonomous delivery needs you — or ships",
    highlights: [
      {
        kind: "feature",
        text: "Autonomous delivery can now notify you (in-app + push): when a change parks for your review — failed checks, a risky change, a reviewer rejection, or a question — and, optionally, whenever a version ships to production. Toggle each in Settings → Feedback automation.",
      },
    ],
  },
  {
    version: "2.164.5",
    date: "2026-07-10",
    title: "Sub-tasks stay under their parent",
    highlights: [
      {
        kind: "fix",
        text: "Add a sub-task to a task, open the sub-task, then go back to the parent — the sub-task stays listed under the parent instead of vanishing. The parent's sub-item list now reflects what's actually saved every time you open it, so a sub-task that still exists always shows up under the right parent without a manual page refresh.",
      },
    ],
  },
  {
    version: "2.164.4",
    date: "2026-07-10",
    title: "The New issue button reliably creates issues",
    highlights: [
      {
        kind: "fix",
        text: "The \"New issue\" button now creates your item every time. Previously it could leave you filling in the form with no way to submit — or quietly fail after you clicked Create — even though adding a card straight on the Kanban board worked. It no longer waits on the type list to load before letting you create, and a hiccup loading the project's board can't stop the issue from being saved. Works for every item type (task, story, event day, and so on).",
      },
    ],
  },
  {
    version: "2.164.3",
    date: "2026-07-10",
    title: "Feedback status follows delivery",
    highlights: [
      {
        kind: "fix",
        text: "Feedback items now track the work item they became: when the ticket moves to in-progress, review, or done on the board, the feedback's status updates with it — no more shipped requests stuck at \"Planned\". Existing feedback has been brought current.",
      },
    ],
  },
  {
    version: "2.164.2",
    date: "2026-07-10",
    title: "Wide issue details no longer get cut off",
    highlights: [
      {
        kind: "fix",
        text: "When you open an issue's details, content that's wider than the panel — a table, code block, or long link in the description — now scrolls sideways within that block instead of shoving the whole panel off-screen or getting clipped. Everything stays reachable, even on narrow and mobile screens.",
      },
    ],
  },
  {
    version: "2.164.1",
    date: "2026-07-10",
    title: "Dashboard metric cards look right in dark mode",
    highlights: [
      {
        kind: "fix",
        text: "On the project Dashboard, hovering the Overview metric cards (Total, Completed, In Progress, Overdue) now shows a clear highlight in dark mode, matching how it already looked in light mode.",
      },
    ],
  },
  {
    version: "2.164.0",
    date: "2026-07-10",
    title: "Set a default view for everyone on a project",
    highlights: [
      {
        kind: "feature",
        text: "Project managers, owners, and admins can now pick the default tab a project opens to for the whole team. Open the ⋯ menu on any board or view tab and choose \"Set as default for everyone\" — members who haven't chosen their own default will land there when they open the project. Everyone can still set their own personal default (\"Set as my default\"), which always takes priority for them.",
      },
    ],
  },
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
