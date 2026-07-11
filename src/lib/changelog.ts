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
