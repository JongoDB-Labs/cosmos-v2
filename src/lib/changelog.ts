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
    version: "2.307.0",
    date: "2026-08-26",
    title: "Foreman's Claude connection is recognised where it is actually used",
    highlights: [
      {
        kind: "fix",
        text: "Feedback automation told administrators to connect Claude for Foreman while it was already connected and working, and kept the auto-triage toggle greyed out. The connection was fine; the page was asking a component that had never been told about it. The banner and the toggle now reflect the real connection.",
      },
      {
        kind: "fix",
        text: "The same fault silently disabled both feedback intake judges \u2014 duplicate detection and the security review. They are designed to stand down rather than guess when no AI provider is available, so they reported nothing wrong while never running. They now see the connection and run.",
      },
    ],
  },
  {
    version: "2.306.0",
    date: "2026-08-26",
    title: "Foreman's delivery history starts recording again \u2014 and can now prove it wasn't edited",
    highlights: [
      {
        kind: "fix",
        text: "Foreman had not recorded a single step of its delivery history since 28 July. Two columns were missing from the database, so every write failed \u2014 and because history recording is deliberately unable to interfere with delivery, the failures were swallowed and the screens simply showed nothing. Anything that read that history, including the convergence and cost figures and the dry-run evidence added in the previous release, was reporting on an empty table rather than on no activity. Recording resumes when this release is applied; the four weeks in between cannot be recovered.",
      },
      {
        kind: "improvement",
        text: "Each recorded step now carries a fingerprint of its own contents and of the step before it, so altering, reordering or deleting anything in Foreman's history invalidates every step that follows. A new check reports an intact history, a missing step and an altered step as three different answers \u2014 never as one word \u2014 so \u201cnothing was recorded here\u201d can no longer be mistaken for \u201cnothing was changed here\u201d.",
      },
      {
        kind: "improvement",
        text: "If Foreman ever fails to record a step of its history again, it now says so \u2014 the failure is written to the activity feed as an error, and the delivery screens report whether recording is keeping up with the work the daemon is actually doing. Previously a recording failure and an ordinary quiet period looked identical, which is why the outage above went unnoticed for four weeks.",
      },
      {
        kind: "improvement",
        text: "Each run of the delivery loop also records the pull request it produced alongside the commit, so a completed piece of work can be traced to exactly what it changed. The link is never overwritten once known, so a ticket that pauses a second time keeps it.",
      },
    ],
  },
  {
    version: "2.305.0",
    date: "2026-08-26",
    title: "A rehearsal now leaves a record",
    highlights: [
      {
        kind: "fix",
        text: "Running Foreman in its safe rehearsal mode recorded nothing at all, so the delivery card stayed empty while work was happening and there was no way to tell an idle system from a busy one. Rehearsals are now recorded and clearly marked.",
      },
      {
        kind: "improvement",
        text: "Rehearsals are kept out of the delivery figures. A rehearsal never ships by design, so counting it would have made the success rate look worse the more carefully you tested. The card reports how many rehearsals ran, separately, and says why they are excluded.",
      },
    ],
  },
  {
    version: "2.305.0",
    date: "2026-08-26",
    title: "Bring a trial balance in from your bookkeeping system",
    highlights: [
      {
        kind: "feature",
        text: "Accounting \u2192 Import takes a trial balance exported from your bookkeeping system and brings it into the ledger, so the reports here agree with the books they came from. The ability to do this existed but had no screen, which meant it could only be done by a developer.",
      },
      {
        kind: "improvement",
        text: "Nothing posts until you have seen what it would do. The preview shows the adjustment per account, anything left over that would land in Opening Balance Equity, and whether the file you sent balances at all \u2014 and the figures you approve are the figures that post, because the preview and the posting ask exactly the same question.",
      },
    ],
  },
  {
    version: "2.304.0",
    date: "2026-08-26",
    title: "Connect GitLab to Foreman from the console",
    highlights: [
      {
        kind: "improvement",
        text: "Foreman's Connections settings now offer GitLab alongside GitHub, so the plugin repositories hosted there can be given a read-only token. Until now only GitHub could be connected, which left the plugin releases card comparing against copies that had stopped being updated.",
      },
      {
        kind: "improvement",
        text: "The connection form checks the token against GitLab before saving it, and explains the common mistake up front: a deploy token looks like the right credential but only works for cloning, not for reading project details.",
      },
    ],
  },
  {
    version: "2.303.1",
    date: "2026-08-26",
    title: "Connecting Claude to Foreman now actually enables Foreman",
    highlights: [
      {
        kind: "fix",
        text: "Connecting Claude to Foreman left the auto-triage and autonomous-delivery switches greyed out, with a message asking you to connect Claude for Foreman \u2014 which you had just done. Foreman keeps its own model connection, separate from the organisation-wide one, and the switches were checking the organisation's rather than Foreman's. They now recognise Foreman's own connection.",
      },
    ],
  },
  {
    version: "2.303.0",
    date: "2026-08-26",
    title: "Foreman has a rollout stage you can set, and it starts safe",
    highlights: [
      {
        kind: "improvement",
        text: "Foreman's delivery daemon now has a rollout stage \u2014 paused, dry, or live \u2014 set from the Foreman console instead of a setting only reachable on the server. Dry runs the whole decision path (deciding what to build, spotting duplicates, running checks, reviewing the result) while writing nothing and shipping nothing, so the behaviour can be watched before anything is trusted to it.",
      },
      {
        kind: "improvement",
        text: "The stage starts at dry, and can only ever make Foreman safer: a server-side override can force dry, but nothing in the settings can force it to ship. Turning autonomous delivery on therefore no longer ships anything on its own \u2014 the stage has to be set to live deliberately.",
      },
      {
        kind: "fix",
        text: "A settings table Foreman relies on was never created by any migration \u2014 it existed only where it had been made by hand, so deploy-cadence settings were broken on any freshly set-up instance. The migration now creates it, and leaves existing installations untouched.",
      },
      {
        kind: "improvement",
        text: "The plugin releases card now reads each plugin from wherever it actually lives rather than assuming one host, so the version comparison it shows is accurate again.",
      },
    ],
  },
  {
    version: "2.302.0",
    date: "2026-08-26",
    title: "Foreman can show you whether anyone is actually reviewing its work",
    highlights: [
      {
        kind: "improvement",
        text: "Foreman's delivery console now reports how long a paused ticket waits before a person responds to it, and how many have been waiting more than two weeks. When Foreman stops and asks for a human decision, you can finally see whether those questions are being answered or quietly piling up.",
      },
      {
        kind: "improvement",
        text: "The delivery card also records which individual check decided a build's outcome \u2014 type-checking, linting or tests \u2014 and whether each one actually ran. A check that was skipped no longer looks the same as a check that passed.",
      },
      {
        kind: "fix",
        text: "Foreman no longer parks a good change because a test failed once by chance. A suspect test is now re-run several times before its result is allowed to block anything.",
      },
    ],
  },
  {
    version: "2.301.0",
    date: "2026-08-26",
    title: "An API key that can run checks and nothing else",
    highlights: [
      {
        kind: "fix",
        text: "Scheduled runs of the automated checks could not actually be triggered by an API key \u2014 the permission the endpoint required was not one any key could be granted, so a key created for a scheduler would have been refused every time.",
      },
      {
        kind: "improvement",
        text: "There is now a \u201crun checks\u201d scope that grants exactly that and nothing else \u2014 not even read access. A key left on a scheduler can trigger the checks, but cannot browse the organisation or change which plugins are switched on.",
      },
    ],
  },
  {
    version: "2.300.0",
    date: "2026-08-26",
    title: "Automated checks that run on their own",
    highlights: [
      {
        kind: "feature",
        text: "Automated checks can now be run on a schedule rather than only when somebody happens to open the right page. Without it a flag list is accurate as of the last time anyone looked \u2014 a problem that started on Tuesday raises nothing until someone visits, and one that has since been fixed keeps its flag up just as long.",
      },
      {
        kind: "improvement",
        text: "One misbehaving check cannot stop the others. Each is run separately and a failure is reported rather than hidden, so a check that quietly stopped working is visible instead of looking like a clean run with nothing to report.",
      },
    ],
  },
  {
    version: "2.299.1",
    date: "2026-08-26",
    title: "Open tickets no longer told how they turned out",
    highlights: [
      {
        kind: "fix",
        text: "Hovering a ticket on the Timeline could say \u201c31d ahead of plan\u201d or \u201cSlipped 5d late\u201d for work that had not finished \u2014 it was reading today as if it were the completion date. Early and late are verdicts on finished work, so an open ticket now simply tells you where it stands: \u201c31d left\u201d, \u201cDue today\u201d, or \u201c5d past due\u201d in red. Once it completes you get the verdict: \u201cFinished 5d early\u201d, \u201cFinished 5d late\u201d or \u201cFinished on plan\u201d.",
      },
    ],
  },
  {
    version: "2.299.0",
    date: "2026-08-25",
    title: "Clearing flags one project at a time",
    highlights: [
      {
        kind: "improvement",
        text: "An automated check that examines a single project can now clear only that project's flags. A check knows what is wrong in what it just looked at, so without this it would read every other project's flag as \u201cno longer a problem\u201d and clear it \u2014 which looks identical to the flags correctly resolving themselves.",
      },
    ],
  },
  {
    version: "2.298.0",
    date: "2026-08-25",
    title: "Flags: a standing list of what needs attention",
    highlights: [
      {
        kind: "feature",
        text: "Automated checks can now raise a flag that stays up until the situation behind it actually changes. A notification tells one person once and is gone the moment they read it; a flag is visible to everyone, carries a severity, and can be traced back to the rule that raised it \u2014 so \u201cthis project is over its fee\u201d is something the team can still see next week.",
      },
      {
        kind: "improvement",
        text: "Flags clear themselves. When the condition that raised one stops being true, the flag is marked resolved rather than deleted, so you can still see that it happened and whether it has come back. Dismissing a flag sticks: a check that keeps finding the same thing will not re-raise something you have already judged to be fine.",
      },
    ],
  },
  {
    version: "2.297.0",
    date: "2026-08-25",
    title: "Work in progress no longer claims to have finished early",
    highlights: [
      {
        kind: "fix",
        text: "A ticket that had started but not finished showed GREEN to the right of its bar \u2014 the Timeline was reading the gap between today and the due date as \u201cfinished ahead of plan\u201d for work that had not finished at all. Green and red are now only ever drawn from dates that actually happened: a real start, and a real completion. Until a ticket completes, the time it still has left is drawn plainly, in the bar\u2019s own colour.",
      },
      {
        kind: "improvement",
        text: "A ticket that is overdue and still running now simply shows its bar growing past the end of its planned span, rather than being coloured. Nothing is claimed about how late it finished until it finishes.",
      },
      {
        kind: "improvement",
        text: "The Enablers lens has been removed from the Timeline, along with the hatching and dashed outline it controlled \u2014 it took up space in the lens row without earning it. Enabler work is unaffected everywhere else: you can still filter a board by category, the delivery dashboard still reports on it, and hovering a bar still shows its Enabler tag.",
      },
    ],
  },
  {
    version: "2.296.2",
    date: "2026-08-25",
    title: "The Timeline always shows planned against actual",
    highlights: [
      {
        kind: "improvement",
        text: "The Timeline now always shows each ticket\u2019s planned dates against what actually happened. The \u201cPlan drift\u201d toggle is gone \u2014 it is not an optional view of a Gantt, it is what a Gantt is for. A ticket planned for 28 Jul to 25 Sep that actually began on 11 Aug used to draw a single solid bar from 11 Aug to today and nothing else, unless you knew to switch a lens on; it now shows the late start in red to the left of the bar and the remaining planned time in green to the right, every time. Tickets that are running to plan look exactly as they did, because a mark only appears where the plan and the actuals disagree.",
      },
    ],
  },
  {
    version: "2.296.1",
    date: "2026-08-25",
    title: "The Timeline no longer invents dates for tickets that have none",
    highlights: [
      {
        kind: "fix",
        text: "A ticket with no start date, no due date and nothing actually started was still drawn on the Timeline as an ordinary week-long bar \u2014 built from its creation date plus seven days, neither of which anyone entered. It looked exactly like a real plan. Those tickets now show a small hollow marker labelled \u201cNo dates\u201d instead, so an invented week can never be mistaken for a schedule. Tickets that have any real date keep their bar.",
      },
    ],
  },
  {
    version: "2.296.0",
    date: "2026-08-25",
    title: "Updates that ship without a new version number",
    highlights: [
      {
        kind: "improvement",
        text: "Update checking can now tell you when your current version has been rebuilt — a plugin release ships under the same version number as the core it runs on, so those updates were previously invisible and had to be applied by hand.",
      },
    ],
  },
  {
    version: "2.295.0",
    date: "2026-08-24",
    title: "Past work keeps its cost when people move on",
    highlights: [
      {
        kind: "improvement",
        text: "Historical reports can now include the pay rates of people who have since left. Without it, a finished project's labour cost would shrink as its team moved on, quietly improving the margin on work nobody was still doing.",
      },
    ],
  },
  {
    version: "2.294.0",
    date: "2026-08-24",
    title: "Account-level figures behind the statements",
    highlights: [
      {
        kind: "improvement",
        text: "Reports and plugins can now read what sat in each individual account over a date range, drawn from the same postings the Profit & Loss and Balance Sheet use — so a ratio built on two accounts always agrees with the statements it came from.",
      },
    ],
  },
  {
    version: "2.293.0",
    date: "2026-08-24",
    title: "Bring your bookkeeping figures into the ledger",
    highlights: [
      {
        kind: "feature",
        text: "Import a trial balance from your accounting package — paste the CSV export or type the figures in — and Cosmos posts the one adjusting entry that brings its ledger into line. Profit & Loss, Balance Sheet and Trial Balance then reflect it immediately.",
      },
      {
        kind: "feature",
        text: "Every import previews first: what each account moves from and to, and what the balancing figure would be, before anything reaches the books.",
      },
      {
        kind: "improvement",
        text: "Re-importing a corrected file for the same period posts only the difference, so fixing a figure does not double it.",
      },
    ],
  },
  {
    version: "2.292.0",
    date: "2026-08-23",
    title: "Pay rates remember when they changed",
    highlights: [
      {
        kind: "improvement",
        text: "A change to someone's pay rate now applies from the day you make it. Until now it applied to everything they had ever logged, so entering a raise quietly restated labour costs and margins on work that was already finished and reported.",
      },
      {
        kind: "improvement",
        text: "Pay run previews and project margins cost each hour at the rate that was in force the day it was worked, so a period that straddles a raise splits correctly instead of being priced entirely at the new rate.",
      },
    ],
  },
  {
    version: "2.291.1",
    date: "2026-08-18",
    title: "Milestones that finished early now show it, and the plan is hoverable",
    highlights: [
      {
        kind: "fix",
        text: "Milestones only showed their drift when they were LATE. One that finished ahead of its planned date was drawn off the left edge of the chart and clipped away, so it looked as though early milestones simply did not drift. Both directions now appear \u2014 green when a milestone was pulled in, red when it slipped.",
      },
      {
        kind: "improvement",
        text: "With Plan drift switched on, you can now hover the faded plan itself \u2014 the shadow beside a bar, or a milestone\u2019s planned diamond and the line showing how far it moved \u2014 and get the same date card you get from the bar. Previously only the solid bar responded, which meant the part you point at to ask \u201chow far off was this?\u201d was the one part that ignored you.",
      },
    ],
  },
  {
    version: "2.291.0",
    date: "2026-08-18",
    title: "The timeline says ahead or behind, and says it once",
    highlights: [
      {
        kind: "feature",
        text: "Plan drift on the Timeline now uses one colour scale: green means ahead of plan, red means behind it. Amber is gone \u2014 it used to mean \u201cstarted late\u201d while red meant \u201cfinished late\u201d, so the colour of a mark answered two different questions and could not be read at a glance. A mark is striped where it lies over the solid bar and a soft shadow where it sits beside it, so you can always tell the plan from the work that actually happened.",
      },
      {
        kind: "improvement",
        text: "Bars are now coloured by the kind of work rather than by individual type: purple for epics and features, blue for stories, tasks, sub-tasks and bugs, orange for milestones. Previously only five types had a colour and everything else fell through to green \u2014 the same green that means ahead of plan.",
      },
      {
        kind: "feature",
        text: "Milestones show their drift. A milestone is a date, not a span, so it drifts by moving: you see a faded diamond where it was planned, a solid one where it actually landed, and a line between them coloured by which way it went. Milestones that landed on their date show nothing extra.",
      },
      {
        kind: "fix",
        text: "The Blocked lens now outlines blocked work that has already started \u2014 which is most blocked work. It only ever outlined tickets that had not begun, so the highlight was missing exactly where it was needed and the only clue was that everything else dimmed.",
      },
      {
        kind: "fix",
        text: "Turning on several Timeline lenses at once no longer fades bars almost to nothing. Each lens used to multiply the last, so four together left work at well under one percent opacity \u2014 still on the chart, impossible to see.",
      },
      {
        kind: "feature",
        text: "Moving a ticket into In Progress or Done now asks about all four of its dates at once \u2014 planned start, planned end, actual start and actual end \u2014 instead of only the one the move happened to record. Moves into any other column no longer interrupt you at all.",
      },
      {
        kind: "feature",
        text: "A parent can no longer be marked Done while its children are still open. The move is refused and names the work that has to finish first, so a parent can never report itself complete over unfinished children. The old prompt offering to drag a parent forward when a child overtook it has been removed.",
      },
      {
        kind: "improvement",
        text: "New tickets now require a planned start and end date. Without them a ticket can never appear on the Timeline, and there is nothing for its actual dates to be measured against. Tickets created before this change keep their empty dates until you set them.",
      },
    ],
  },
  {
    version: "2.290.3",
    date: "2026-08-17",
    title: "Blocked Work and Work Type Mix were squashed into unreadable slivers",
    highlights: [
      {
        kind: "fix",
        text: "On a desktop screen the two newest Sprint Health widgets rendered as tiny overlapping boxes in the bottom corner instead of full cards — the panels worked, but nobody could read them. They had never been given a position in the board's grid layout, so they were dropped into a default one-cell slot on top of each other. Both now sit in a full-width row of their own at every screen size.",
      },
    ],
  },
  {
    version: "2.290.2",
    date: "2026-08-13",
    title: "Board move prompts now appear",
    highlights: [
      {
        kind: "fix",
        text: "When a board move recorded an actual start or finish date, the prompt offering to correct it never appeared \u2014 the move saved correctly, but the question was silently lost. It now opens as intended. If one move raises two questions \u2014 bringing a parent forward as well as confirming a date \u2014 they are asked one at a time rather than stacking on top of each other.",
      },
    ],
  },
  {
    version: "2.290.1",
    date: "2026-08-15",
    title: "Board dates you can trust, and correct",
    highlights: [
      {
        kind: "fix",
        text: "Moving a ticket on a board no longer records a start date it should not. The rule that decided whether a move meant \u201cstarted\u201d or \u201cfinished\u201d was guessing from the column\u2019s name, so a board with a column called Review recorded work as starting the moment a ticket reached review, and a Done column named something else \u2014 Shipped, say \u2014 never recorded a finish at all. Both now use the column\u2019s configured category.",
      },
      {
        kind: "feature",
        text: "When a move does record an actual start or finish, you are now asked whether that date is right. Catching a board up days after the work happened used to stamp everything with today\u2019s date and leave no way to correct it; you can now set the real date there and then, or keep today and move on.",
      },
      {
        kind: "feature",
        text: "If a ticket moves ahead of its parent \u2014 a sub-task reaching In Progress while its parent sits in Backlog \u2014 you are offered the chance to bring the parent forward too. Nothing is moved without asking, and a ticket moving backwards never drags its parent with it.",
      },
      {
        kind: "improvement",
        text: "Every date change on a ticket is now recorded in its history, including dates the system fills in for you. Previously the history tracked status, sprint, assignee and type but no dates at all, so a date that changed unexpectedly left no trail to follow.",
      },
    ],
  },
  {
    version: "2.290.0",
    date: "2026-08-14",
    title: "Blocked work and increment objectives on Sprint Health",
    highlights: [
      {
        kind: "feature",
        text: "Blocked work: what is stuck, what it is waiting on, and how long it has stood — longest first, because the oldest block has cost the most and is least likely to resolve itself. Both link directions count: “A is blocked by B” and “B blocks A” state the same fact, and which one exists just depends on which issue you were looking at when you made the link.",
      },
      {
        kind: "improvement",
        text: "The age is measured from when the block was RECORDED, and the panel says so rather than implying it knows when work actually stopped. Blocking links pointing at work that is already finished are not counted as impediments, but the number of them is shown — invisible clutter is what makes the real blocks hard to see.",
      },
      {
        kind: "feature",
        text: "Increment objectives, under Across time → By increment: how many committed objectives are met and the average progress, with stretch objectives listed but held OUT of that figure. Stretch objectives are deliberately not part of the commitment — averaging them in punishes the teams who surface upside, and is the most common way a PI report reads worse than the increment actually went.",
      },
    ],
  },
  {
    version: "2.289.0",
    date: "2026-08-14",
    title: "Carryover and predictability on Sprint Health",
    highlights: [
      {
        kind: "feature",
        text: "Carryover: what rolled from one sprint into the next, shown on both sides of the move — what a sprint inherited and what it failed to finish. Work sent back to the backlog is NOT counted: that is descoping, which the scope-change panel already reports, and conflating the two would flatter a team that keeps dropping work while punishing one that keeps honouring it.",
      },
      {
        kind: "feature",
        text: "The tickets that slipped more than once are called out separately. One slip is a sprint that ran long; the same ticket slipping three sprints running is something nobody is actually working on, and that is the conversation worth having.",
      },
      {
        kind: "feature",
        text: "Predictability: how much of its commitment the team keeps on average, and how much that varies. It is built from commitment rather than velocity, because hitting the same point total every sprint while finishing a different half of what was promised is consistency, not predictability. It stays silent until five sprints have closed with something committed, and says how many it has — this is a number that gets quoted at people.",
      },
    ],
  },
  {
    version: "2.288.4",
    date: "2026-08-14",
    title: "A team's sprint review reports that team's sprint",
    highlights: [
      {
        kind: "feature",
        text: "Choosing a team on a Sprint Review / Retro board now scopes the whole review, not just capacity: story points, completion, items delivered, what shipped and what carries forward all count that team's work. A lead can read their own numbers to their own team without subtracting the rest of the project in their head.",
      },
      {
        kind: "improvement",
        text: "A team's work is what its members are assigned, the same rule the board filters and capacity planning already use — so every panel on the board counts the same people.",
      },
    ],
  },
  {
    version: "2.288.3",
    date: "2026-08-14",
    title: "Sprint ceremony boards can belong to a team",
    highlights: [
      {
        kind: "feature",
        text: "The Sprint Planning and Sprint Review / Retro boards now run a ceremony for one team. Give a board a team and it becomes that team's ceremony — it names whose it is and offers no picker, so nobody retargets another squad's board by accident. A board with no team lets you choose, opening on the team you lead.",
      },
      {
        kind: "improvement",
        text: "Capacity on a team's board counts that team's people and that team's committed work together, so headroom never measures one squad's hours against the whole project's commitment.",
      },
      {
        kind: "fix",
        text: "Starting and closing a ceremony is the facilitator's job, but the button was shown to everyone — a team member who pressed it got a permission error in front of the room. It now appears only for people who can run a sprint. Everyone else still reads the ceremony's state and still adds notes and action items, which is the point of a retro.",
      },
      {
        kind: "fix",
        text: "The control to delete your own retro note was invisible until you happened to move the pointer over the note. It is now visible, and still quiet enough not to compete with the note itself.",
      },
    ],
  },
  {
    version: "2.288.2",
    date: "2026-08-13",
    title: "One “Across time” tab, with a sprint / increment toggle",
    highlights: [
      {
        kind: "improvement",
        text: "“Trend across sprints” and “PI rollup” were two tabs asking the same question at two altitudes, so anyone wanting both had to remember which tab held which. They are now one tab — Across time — with a By sprint / By increment toggle. The scope is the variable, not the destination, and sprint stays the default because that is the cadence teams actually run on.",
      },
      {
        kind: "improvement",
        text: "Switching to By increment shows the increment rollup rather than re-pointing the sprint panels at Program Increments. A PI holds no work items of its own, so a throughput bar for one reads zero and a cycle time over one is empty — those panels would render perfectly and tell you something untrue.",
      },
    ],
  },
  {
    version: "2.288.1",
    date: "2026-08-13",
    title: "Times shown on screen follow your own clock",
    highlights: [
      {
        kind: "fix",
        text: "Timestamps such as an API key's \"last used\", when an allow-list entry was added, when a report last ran and when a ceremony was closed are shown in your own time zone. Previously they were formatted using whatever locale and zone the server happened to run in, which could disagree with your browser and make a page fail to load. They now appear briefly in a fixed form and settle to your local time a moment later, without the page breaking.",
      },
    ],
  },
  {
    version: "2.288.0",
    date: "2026-08-13",
    title: "Sprint Health now shows what you committed to, and what changed after",
    highlights: [
      {
        kind: "feature",
        text: "Commitment and scope change, per sprint: how much of the plan you kept, plus what was pulled in or pushed out after the sprint started. Every other number on this board describes the sprint as it stands now — a team that finished 90% of a sprint it doubled halfway through looked identical to one that finished 90% of what it committed to. Now they don't.",
      },
      {
        kind: "improvement",
        text: "Moves made BEFORE a sprint starts are treated as planning, not churn. Grooming the backlog into next sprint is the process working, and counting it would make every well-planned sprint look chaotic while burying the mid-sprint injections that actually cost the team something.",
      },
      {
        kind: "improvement",
        text: "An item that bounces in and out of a sprint counts once, not once per move — “committed” is reconstructed from the interval history rather than guessed, and the panel says so underneath. Where nothing was committed at planning it says “no commitment” rather than reporting 300% delivery.",
      },
    ],
  },
  {
    version: "2.287.6",
    date: "2026-08-13",
    title: "Dates on the organisation overview stop depending on the server",
    highlights: [
      {
        kind: "fix",
        text: "The \"Updated\" date on the organisation overview's project cards was formatted using the server's own locale rather than a fixed one, so the page could be built with different text than your browser expected and fail to load with a \"Something went wrong\" message. It now formats consistently, the same way the projects list was fixed earlier. The \"Expires\" date on API keys and the created date in the classification list are corrected the same way.",
      },
    ],
  },
  {
    version: "2.287.5",
    date: "2026-08-13",
    title: "A Program Increment is shown by its name",
    highlights: [
      {
        kind: "fix",
        text: "When assigning a milestone to a Program Increment, the picker and the Schedule register's PI column showed something like \"PI-7 \u00b7 PI-001\". The \"PI-7\" part was not real: intervals are numbered in one sequence per project that counts sprints too, so a project's first Program Increment is often the seventh interval created. A Program Increment is now shown simply by the name you gave it, and the column sorts the way it reads. An interval with no name still falls back to its sequence number.",
      },
    ],
  },
  {
    version: "2.287.4",
    date: "2026-08-13",
    title: "Throughput no longer claims a team never varies",
    highlights: [
      {
        kind: "fix",
        text: "With a single closed sprint, Throughput reported “±0% variation”. That is arithmetically true — the spread of one number is zero — and it reads as “this team is perfectly predictable”, which is a claim about people that one sprint cannot support. Variation now appears only once three sprints have closed, and until then the panel says so instead. The average is unchanged: finishing 34 items in a sprint is a fact about that sprint and still shows from the first one.",
      },
    ],
  },
  {
    version: "2.287.3",
    date: "2026-08-13",
    title: "Plan a sprint for your own team, not for the whole project",
    highlights: [
      {
        kind: "feature",
        text: "Capacity planning can now be scoped to one team, and opens on the team you lead. A lead sizing their own sprint no longer has to mentally subtract every other squad — the equivalent of putting all of them in the room for each other's planning. Switch to another team, or to All teams, from the picker at the top; projects with no teams are unchanged.",
      },
      {
        kind: "improvement",
        text: "The capacity total now reports the team you are looking at rather than the whole project, so the number a team commits to is that team's number. Capacity recorded for other teams is left untouched when you save.",
      },
    ],
  },
  {
    version: "2.287.2",
    date: "2026-08-13",
    title: "A retro running in front of the team now updates for everyone watching",
    highlights: [
      {
        kind: "fix",
        text: "Notes and action items added during a ceremony never appeared for anyone else — a second person with the board open had to reload to see anything, which is the opposite of what a live retro needs. They now appear as they are added.",
      },
      {
        kind: "fix",
        text: "The same gap silently affected work-item link changes and new organisations, which also never reached other open tabs.",
      },
    ],
  },
  {
    version: "2.287.1",
    date: "2026-08-13",
    title: "Self-hosted updates no longer need a copy of the source repo",
    highlights: [
      {
        kind: "improvement",
        text: "The delivery daemon worked out “what is the newest release?” by reading git tags from a checkout of the source, which only works when the daemon and the instance it updates sit on the same machine. On any other instance it found no tags and reported nothing to update — indistinguishable from being up to date. It now asks the image registry, which is the same place the Updates page already asks and the same place the deploy pulls from.",
      },
      {
        kind: "fix",
        text: "A registry it cannot reach now refuses the pass and says so, rather than reading as “no new version”. An unreachable registry and an up-to-date instance used to look identical in the log.",
      },
    ],
  },
  {
    version: "2.287.0",
    date: "2026-08-13",
    title: "Sprint Health answers the questions a retro actually opens with",
    highlights: [
      {
        kind: "feature",
        text: "Cycle time: once work starts, how long until it is done. Median, 85th percentile and a distribution, so you can say “most things land inside nine days” rather than guessing. It reports how much of your finished work it could actually measure — only items with a recorded start can be timed — and shows no figure at all when nothing can be, instead of a “0 days” that reads as instant delivery.",
      },
      {
        kind: "feature",
        text: "Throughput: how many items you finish per sprint, with the rolling average and how much it varies. The sprint you are in is drawn faded and left out of the average, because a sprint three days old has delivered three days of work and averaging that in makes every team look like it is slowing down. A sprint that finished nothing still gets its bar — closing the gap would quietly redraw the trend as though it never happened.",
      },
      {
        kind: "feature",
        text: "Work type mix: where capacity is going, cut by work item type and by business-versus-enabler. Status and priority say where work stands, neither says what kind of work it is — and a sprint that is 60% defects and one that is 60% features call for opposite conversations.",
      },
      {
        kind: "improvement",
        text: "Every one of these reads the filtered set, so narrowing to a team, an assignee or a label re-answers all of them for that slice. Where a number is built on partial data the panel says so underneath it, including items excluded for finishing before they started.",
      },
    ],
  },
  {
    version: "2.286.6",
    date: "2026-08-13",
    title: "Present mode now actually makes the ceremony readable from a room",
    highlights: [
      {
        kind: "fix",
        text: "Present mode on the ceremony boards went full-screen but changed almost nothing else: only the board title grew. The story-point figure, the completion percentage, the labels and the section tabs all stayed at their desk sizes, which is the one thing a presentation view exists to prevent. Everything now scales together — the headline figures are half again as large.",
      },
    ],
  },
  {
    version: "2.286.5",
    date: "2026-08-13",
    title: "Rolling into the next sprint now starts the one you already planned",
    highlights: [
      {
        kind: "fix",
        text: "Completing a sprint and accepting the offer to start the next one always CREATED a sprint, even when the next one was already planned — so a team who plans ahead ended up with two sprints of the same name, and their real one was left sitting untouched. When the next sprint already exists, that sprint is now started in place; nothing new is created and its dates are left alone.",
      },
      {
        kind: "improvement",
        text: "The roll-over dialog says which of the two it is about to do. For a sprint that already exists it names it — “Start Sprint 2?” — and shows its dates as a record rather than as editable fields, because editing them there was what quietly built a second sprint.",
      },
    ],
  },
  {
    version: "2.286.4",
    date: "2026-08-12",
    title: "Sprint ceremony boards: the retro's follow-through now works end to end",
    highlights: [
      {
        kind: "fix",
        text: "Promoting a retro action into a work item produced a link that went nowhere — a 404. Promote is the control that decides whether a retro changes anything, so the single action a team agreed on was also the one they could not open. Tracked items now link straight to the work item.",
      },
      {
        kind: "fix",
        text: "The Owner picker on action items listed a blank row for every member, and the Owner column showed a dash even for actions that had an owner. Owners now show by name, falling back to their email address.",
      },
      {
        kind: "fix",
        text: "An action item's due date showed the day before the one you picked, for anyone in a time zone behind UTC — enter the 15th, see the 14th.",
      },
      {
        kind: "fix",
        text: "Completing a sprint suggested a name for the next one by counting up, without checking whether it already existed. A team who plans a sprint ahead — which is most of them — ended up with two sprints of the same name. The suggestion now skips names already in use.",
      },
      {
        kind: "improvement",
        text: "The review's Next sprint tab showed a suggested sprint even when the team had already planned the real one, so invented dates were presented in the same voice as fact. It now shows the actual sprint when one exists, and labels a suggestion as “Suggested — not created yet”.",
      },
      {
        kind: "improvement",
        text: "Sprint planning's Capacity panel announced “Within capacity” when no per-member capacity had been recorded at all — reassurance drawn from no data, sitting next to a note saying headroom would read as negative. Capacity now reads “Not set” and headroom stays unknown until you set one.",
      },
    ],
  },
  {
    version: "2.286.3",
    date: "2026-08-12",
    title: "“No active sprint data” while a sprint was plainly running",
    highlights: [
      {
        kind: "fix",
        text: "The burndown on Sprint Health reported no data whenever a project used Program Increments. A PI stays active for as long as any sprint inside it is running, and is numbered above its sprints — so the code asking for “the active interval” got the increment, which holds no work items of its own, and every chart built from it read zero. The same mistake was reporting the increment's name as the current sprint on the portfolio view and on project cards, and was making Cosmo's sprint brief summarise an empty container. All of them now ask for the iteration the team is actually in.",
      },
    ],
  },
  {
    version: "2.286.2",
    date: "2026-08-12",
    title: "Sprint Health can be filtered, and has a real burndown",
    highlights: [
      {
        kind: "feature",
        text: "Sprint Health now has the same filter bar as every other board. Until now every number on it described the whole project, so there was no way to ask “how is my team doing?” or “how are the critical items going?” without leaving the page. The filter applies to every tab, including the charts.",
      },
      {
        kind: "feature",
        text: "A new Burndown tab charts any sprint — not only the one in flight — with remaining work, work completed and an ideal line, in items or story points. It says plainly when it cannot be trusted: if completed work has no recorded completion date it is counted today rather than back-dated, and if most items have no estimate the points view tells you so instead of quietly showing a smaller sprint.",
      },
      {
        kind: "fix",
        text: "The existing burndown widget was measuring the wrong things. It added story points to a count of un-estimated items, producing a total that was neither; it drew the ideal line burning down across weekends, so every team looked behind on a Monday; it compared completion times against a boundary set at the sprint's start time rather than midnight; and an item reopened after being finished stayed counted as delivered. All four are corrected.",
      },
    ],
  },
  {
    version: "2.286.1",
    date: "2026-08-12",
    title: "Sprint ceremony boards open on the right sprint, with the right dates",
    highlights: [
      {
        kind: "fix",
        text: "The Sprint Review / Retro and Sprint Planning boards listed the Program Increment in their sprint picker and opened on it. An increment holds no work of its own, so the board greeted you with a review reading 0 points and 0 of 0 items — which reads as a statement about the team rather than the wrong thing being selected. The picker now lists only sprints, and opens on the one you are in.",
      },
      {
        kind: "fix",
        text: "Sprint and increment dates on the Summary tab read one day early for everyone in a time zone behind UTC — a sprint starting the 28th showed as the 27th. The Next sprint tab had it right, so the same sprint window disagreed with itself across two tabs of one screen.",
      },
      {
        kind: "improvement",
        text: "Both ceremony boards now line up with the rest of the page. Their content sat flush against the sidebar, out of step with every other element, and pressed right up against the board tabs above it, while the header stretched out past the cards below. The section tabs no longer span the full width either, so they read as a set of choices rather than an empty toolbar.",
      },
    ],
  },
  {
    version: "2.286.0",
    date: "2026-08-12",
    title: "Sprint Health can now look across sprints and across a Program Increment",
    highlights: [
      {
        kind: "feature",
        text: "The Sprint Health board has three views. Current sprint is unchanged and still the default. Trend across sprints charts velocity and completion for every finished sprint, with your average and most recent called out. PI rollup totals points, items and sprints for each Program Increment.",
      },
      {
        kind: "improvement",
        text: "Sprints that finished before velocity was being recorded are left out of the charts rather than drawn as zero \u2014 \u201cnot recorded\u201d and \u201cdelivered nothing\u201d are different things. A sprint still in flight is also left out, so a half-finished sprint does not appear next to complete ones as a sudden drop.",
      },
    ],
  },
  {
    version: "2.285.0",
    date: "2026-08-12",
    title: "See what is blocked on the Timeline, and hide what is finished",
    highlights: [
      {
        kind: "feature",
        text: "Two new lenses on the Timeline / Gantt board. Blocked turns impeded work red and draws a line to whatever is holding it up, with everything else faded back, so a large plan answers \u201cwhat is stuck?\u201d at a glance. Hide done drops finished work from the chart so what is still in play has room.",
      },
      {
        kind: "fix",
        text: "Progress shading on Timeline bars always showed zero. The board worked out which statuses count as done from its own columns, and a Timeline board has none \u2014 so nothing ever counted as finished. It now reads the project's workflow, the same place the Status filter takes its options from.",
      },
    ],
  },
  {
    version: "2.284.1",
    date: "2026-08-12",
    title: "The Updates page now confirms an install that worked",
    highlights: [
      {
        kind: "fix",
        text: "After starting an update from the Updates page, the result vanished the moment it succeeded. The outcome and the server log lived inside the “Install this version” panel, and finishing an install means there is nothing left to install — so that panel disappeared and took the confirmation with it, leaving you to infer success from the version number with the log no longer readable. An install that FAILED stayed on screen, so the one result you most want to see was the only one being hidden. The last install and its full log now appear in their own section whether or not another update is waiting.",
      },
    ],
  },
  {
    version: "2.284.0",
    date: "2026-08-12",
    title: "Every board that lists work can now be filtered",
    highlights: [
      {
        kind: "feature",
        text: "The Roadmap, Backlog and Table boards now have the same filter bar as the rest \u2014 search, assignee, type, priority, status, labels, due date and more. With Calendar and RAID last release, every board that lists work items now filters the same way, so narrowing by the same thing gives the same answer wherever you do it.",
      },
      {
        kind: "improvement",
        text: "The Backlog had its own \u201cAssigned to me\u201d button that now duplicated the one in the filter bar; the bar's version does exactly the same thing, so the duplicate is gone. The filter bar also stays on screen when a filter leaves a board empty \u2014 previously it could disappear along with the results, leaving no way to undo the filter.",
      },
    ],
  },
  {
    version: "2.283.3",
    date: "2026-08-12",
    title: "The Next sprint tab on ceremony boards is laid out properly",
    highlights: [
      {
        kind: "improvement",
        text: "The Next sprint tab put a full-width panel holding three short lines above an unframed list, leaving most of the screen empty. It now reads as two columns \u2014 the increment's dates and carry-in on the left, the work rolling into it on the right \u2014 and content no longer stretches across a wide monitor.",
      },
    ],
  },
  {
    version: "2.283.2",
    date: "2026-08-12",
    title: "The Install button on the Updates page now works",
    highlights: [
      {
        kind: "fix",
        text: "Starting an update from the Updates page always failed. One safety check — whether the server has enough free disk for the download and the pre-update backup — cannot be answered from inside the application, so it is handed to the server to answer at the moment it starts. The page understood that, showed the check as “checked on the host”, and offered the button; the request behind the button did not, and treated the handed-off check as a failure. Every install was refused with “Blocked by 1 check(s): Disk headroom”, on the same screen that said all blocking checks had passed. Both sides now read it the same way, and the disk check still runs on the server before anything is downloaded.",
      },
    ],
  },
  {
    version: "2.283.1",
    date: "2026-08-12",
    title: "Filters on the Calendar and RAID boards",
    highlights: [
      {
        kind: "feature",
        text: "The Calendar and RAID boards now have the same filter bar as the other boards \u2014 search, assignee, type, priority, status, labels, due date and the rest. They previously had no filtering at all, so on a busy project the only way to narrow them was to look harder.",
      },
      {
        kind: "improvement",
        text: "All boards that filter now share one definition of what a filter means, so narrowing by the same thing gives the same answer wherever you do it.",
      },
    ],
  },
  {
    version: "2.283.0",
    date: "2026-08-12",
    title: "Milestones belong to a Program Increment; Branches retired",
    highlights: [
      {
        kind: "feature",
        text: "A schedule milestone can now be assigned to a Program Increment, from the Schedule tab of the PM Dashboard or from the milestone\u2019s own panel. The picker offers the Program Increments belonging to that project, so a milestone can be grouped under the increment that actually contains it, and the Schedule register gains a PI column you can sort by. Existing milestones start unassigned \u2014 nothing is guessed on your behalf \u2014 and you can set them as you go.",
      },
      {
        kind: "improvement",
        text: "Branches have been removed. They could only ever be created by seeding \u2014 there was no way to add, rename or delete one in the product \u2014 so the Branch column, filter and picker have gone from the Schedule, Deliverables, Blocked Items and Change Log registers, along with the Deliverable \u201cBranch owner\u201d field. Any branch labels previously recorded against milestones or risks are permanently removed. Exported workbooks keep their column layout, with the Branch cells now blank.",
      },
      {
        kind: "improvement",
        text: "The milestone \u201cPhase\u201d, \u201cMilestone type\u201d and \u201cRelated reference\u201d fields have been retired. They were unused, and dropping them shortens the milestone form. \u201cPhase\u201d is also no longer recognised when importing a spreadsheet; other columns import as before, and an unrecognised column is skipped rather than failing the import.",
      },
    ],
  },
  {
    version: "2.282.1",
    date: "2026-08-12",
    title: "Unfinished work rolls into the next sprint, and the ceremony boards read better",
    highlights: [
      {
        kind: "improvement",
        text: "Completing a sprint now offers to move unfinished work to the NEXT sprint by default, the way you would expect. It previously defaulted to the backlog, so unless you noticed the dropdown, finishing a sprint quietly took the remaining work off every sprint. You can still choose the backlog \u2014 or any planned sprint \u2014 in the dialog.",
      },
      {
        kind: "improvement",
        text: "Present mode on the ceremony boards is now actually readable from across a room; it previously used the same text sizes as the normal view. The Next sprint tab also shows its dates in the same format as the rest of the board instead of raw 2026-08-17 form, and counts read \u201c1 item\u201d rather than \u201c1 items\u201d.",
      },
    ],
  },
  {
    version: "2.282.0",
    date: "2026-08-12",
    title: "Filter by status on the Timeline / Gantt board",
    highlights: [
      {
        kind: "feature",
        text: "The Status filter is now available on the Timeline / Gantt board, under \u201cMore filters\u201d. It was missing because the filter offered only the statuses belonging to the board you were on, and a Timeline board has none of its own \u2014 so the control never appeared. Status belongs to the project's workflow, so the options now come from there and are the same wherever you filter.",
      },
    ],
  },
  {
    version: "2.281.1",
    date: "2026-08-12",
    title: "The Sprint board no longer offers a Milestone filter",
    highlights: [
      {
        kind: "improvement",
        text: "A milestone spans months and cuts across sprints, so on a board already showing a single sprint the Milestone filter almost always matched everything or nothing. It has been removed there \u2014 boards that span sprints, like Kanban and Timeline, still have it. The sprint board also stops loading milestone data it was not going to show.",
      },
    ],
  },
  {
    version: "2.281.0",
    date: "2026-08-11",
    title: "Groundwork for starting an update from the Updates page",
    highlights: [
      {
        kind: "improvement",
        text: "Preparation only \u2014 nothing looks different yet. Cosmos can now record an administrator\u2019s request to install a specific version, with the safety checks applied at the moment the request is made rather than when the page was last loaded, and with a guarantee that two installations can never run at once. The control that uses this arrives with the piece that performs the installation, so that a button never appears before there is something behind it.",
      },
    ],
  },
  {
    version: "2.280.0",
    date: "2026-08-11",
    title: "Safety checks are now run by whichever part of the system can actually see the answer",
    highlights: [
      {
        kind: "improvement",
        text: "One of the pre-update safety checks \u2014 whether there is enough disk space for the new version and the database backup taken before it \u2014 cannot be answered by Cosmos itself, because the application has no visibility of the server\u2019s disk. It was previously shown as an unanswered check that would block any update indefinitely. It is now clearly marked as checked on the server immediately before an update starts, where the answer is actually available, and the update is refused there if the space is not free.",
      },
    ],
  },
  {
    version: "2.279.4",
    date: "2026-08-11",
    title: "Today is your today, not UTC's",
    highlights: [
      {
        kind: "fix",
        text: "Later in the day, anything that defaulted to \u201ctoday\u201d jumped to tomorrow. Time tracking opened on the wrong day and highlighted the wrong column, and a new journal entry or finance record would have been dated a day ahead \u2014 posting into the wrong day. These now read your computer's clock.",
      },
      {
        kind: "improvement",
        text: "Dates that are a whole day rather than a moment \u2014 a due date, a sprint's start and end, the day a time entry belongs to \u2014 deliberately do NOT shift with your time zone, so a sprint that ends on the 20th shows the 20th everywhere. Only genuine timestamps follow your local time.",
      },
    ],
  },
  {
    version: "2.279.3",
    date: "2026-08-11",
    title: "The Type dropdown shows the type you just picked",
    highlights: [
      {
        kind: "fix",
        text: "Changing an item's Type in the side panel updated the type shown next to the ticket number but left the dropdown you had just clicked showing the old one. It now updates immediately \u2014 and if the change fails to save, the dropdown goes back to the type that is actually stored instead of keeping the one that was rejected.",
      },
    ],
  },
  {
    version: "2.279.2",
    date: "2026-08-11",
    title: "Search finds work items by their ticket number",
    highlights: [
      {
        kind: "fix",
        text: "Searching for a ticket number found nothing. Both the search bar and \u2318K matched only the title, even though every result displays the number \u2014 so the one identifier people actually quote to each other was the one thing you could not search for. \u201c3\u201d, \u201cFAL-3\u201d and \u201c#3\u201d now all find the item, and searching by words works exactly as before.",
      },
    ],
  },
  {
    version: "2.279.1",
    date: "2026-08-11",
    title: "Sprints inside a Program Increment can be started again",
    highlights: [
      {
        kind: "fix",
        text: "A sprint could not be started while its own Program Increment was running \u2014 it asked you to finish the previous interval first, and the previous interval WAS the increment the sprint belongs to. Since an increment only finishes when its sprints do, that could never be satisfied. Sprints inside an increment now start normally.",
      },
      {
        kind: "improvement",
        text: "A Program Increment is now treated as what it is: a container for sprints, not an iteration of its own. It starts by itself when its first sprint starts, so there is no Start button on it any more, and it can only be completed once every sprint inside it is finished \u2014 and if any are still open, the message names them.",
      },
      {
        kind: "fix",
        text: "When starting an interval is refused, the screen now shows the real reason instead of a fixed message. Previously every refusal read \u201cAnother interval is already active\u201d, which after this change would often have been wrong.",
      },
    ],
  },
  {
    version: "2.279.0",
    date: "2026-08-11",
    title: "Run sprint planning and sprint review from Cosmos, not a slide deck",
    highlights: [
      {
        kind: "feature",
        text: "Two new board types, Sprint Planning and Sprint Review / Retro, replace the deck most teams rebuild before every ceremony. The numbers are already yours: points delivered, how much of the sprint completed, what shipped ranked heaviest first, what is carrying forward, and the next sprint's dates all come straight from your work items. Nobody retypes them, and they cannot go stale mid-meeting.",
      },
      {
        kind: "feature",
        text: "The retrospective is part of the board. Start / Stop / Continue are ordinary board columns, so you can rename or recolour them — to Went well / Didn't / Try next, or whatever your team uses — without asking for a change. Notes appear for everyone in the room as they are added, and are shown without names by default, because a retro is only honest when nobody has to sign their complaint.",
      },
      {
        kind: "feature",
        text: "Action items can be promoted into real, tracked work in one click, landing on the next sprint with their owner and due date. That is the difference between a decision the team acts on and a list nobody opens again. Press Present for a full-screen view to run the meeting from.",
      },
      {
        kind: "improvement",
        text: "Completing a sprint now records which items rolled into the next one. Previously that was worked out on the fly, so once a sprint closed the list read as empty — a finished sprint could look as though it had carried nothing. Sprints completed before this change say plainly that the list was not recorded, rather than showing a clean slate that never existed.",
      },
    ],
  },
  {
    version: "2.278.2",
    date: "2026-08-11",
    title: "Release notes now load, and registry sign-in details stay with their own registry",
    highlights: [
      {
        kind: "fix",
        text: "The Updates page reported that no release notes had been published even when they had. Notes are now read correctly.",
      },
      {
        kind: "fix",
        text: "Where release notes are hosted somewhere other than your image registry, the sign-in details for the image registry were being sent to that other host as well. They now go only to the registry they belong to. The other host rejected them, but if your installation reads notes from a different registry than it pulls images from, rotating that registry credential is the cautious step.",
      },
    ],
  },
  {
    version: "2.278.1",
    date: "2026-08-11",
    title: "The Updates page now checks the live-collaboration services too",
    highlights: [
      {
        kind: "improvement",
        text: "Plugins that run their own live service \u2014 the whiteboard and PI planning collaboration servers \u2014 ship as separate pieces alongside the main application. The Updates page now confirms those were published for the same release, and refuses to present an update as safe if one is missing. Upgrading without them would leave live collaboration running old code while everything else looked fine.",
      },
    ],
  },
  {
    version: "2.278.0",
    date: "2026-08-11",
    title: "The Updates page now shows what is actually in a new version",
    highlights: [
      {
        kind: "feature",
        text: "When a newer version of Cosmos is available, the Updates page now lists what changed in it \u2014 read straight from the release, without downloading anything. Previously it could tell you a new version existed but not what was in it, which is most of what you need to decide whether to take it.",
      },
      {
        kind: "improvement",
        text: "If notes have not been published for a release, the page says so plainly rather than showing an empty space that could be mistaken for \u201cnothing changed\u201d. When an instance is many versions behind, it also says how many older releases it did not list.",
      },
    ],
  },
  {
    version: "2.277.2",
    date: "2026-08-11",
    title: "The Updates page now tells you when it is still working, or could not finish",
    highlights: [
      {
        kind: "fix",
        text: "The Updates page showed its heading and then an empty space while it was contacting the registry, and stayed empty if that contact failed — so “still checking”, “couldn’t check” and “nothing to report” all looked identical. It now says which of those is happening, and offers a retry when a check fails.",
      },
    ],
  },
  {
    version: "2.277.1",
    date: "2026-08-11",
    title: "Automatic delivery of new versions works again",
    highlights: [
      {
        kind: "fix",
        text: "The service that installs new versions of Cosmos had been looking for them in a location they stopped being published to, so it reported that a release “was not built yet” indefinitely — for versions that had in fact already been built. Because that reads as a normal wait rather than a fault, nothing raised an alarm. It now looks wherever this installation is actually configured to get its images from.",
      },
    ],
  },
  {
    version: "2.277.0",
    date: "2026-08-11",
    title: "See at a glance whether a newer version of Cosmos is available",
    highlights: [
      {
        kind: "feature",
        text: "Administrators get a new Updates page under System administration. It shows the version this installation is running, whether a newer one has been published, and how many releases you are behind — so finding out no longer means asking someone or reading a release feed.",
      },
      {
        kind: "improvement",
        text: "The Updates page also runs a set of safety checks against any newer version it finds, and shows what each one concluded: whether the matching database-migration image was published alongside it, whether the image came from the registry this installation is configured for, and whether the database is reachable. Checks that could not be run are shown as unknown rather than quietly counted as passed.",
      },
      {
        kind: "improvement",
        text: "If the registry cannot be reached, the page says so plainly instead of reporting that you are up to date — not knowing and being current are different answers, and only one of them is safe to act on.",
      },
    ],
  },
  {
    version: "2.276.8",
    date: "2026-08-11",
    title: "Live collaboration keeps working when the realtime service is on its own address",
    highlights: [
      {
        kind: "fix",
        text: "On installations where the live-collaboration service runs on a separate address, the browser silently refused to connect to it. Boards still opened and saved, so nothing looked wrong \u2014 people simply never saw each other's cursors or edits, with no message explaining why. The connection is now permitted for the address each installation is actually configured to use.",
      },
      {
        kind: "fix",
        text: "A whiteboard left open on screen kept re-saving itself even when nobody was drawing, which made boards look as though they had just been edited when they had not. Boards now save when something actually changes.",
      },
    ],
  },
  {
    version: "2.276.7",
    date: "2026-08-11",
    title: "Whiteboards are now part of the build",
    highlights: [
      {
        kind: "feature",
        text: "The Whiteboard — freehand drawing and diagramming boards you can work on alone or together, with a library of ready-made templates — is now included in Cosmos. It stays switched off until an administrator turns it on for your organisation, so nothing changes until you ask for it. Once enabled, Whiteboard appears in the sidebar and boards are private to their creator until explicitly shared.",
      },
    ],
  },
  {
    version: "2.276.6",
    date: "2026-08-11",
    title: "Routine dependency updates",
    highlights: [
      {
        kind: "improvement",
        text: "Ten of the third-party libraries Cosmos is built on were updated to their latest minor and patch releases, including the icon set and the accessibility checker used in testing. Nothing works differently — these are the routine updates that keep the product current with upstream fixes rather than letting them pile up into a risky jump later.",
      },
    ],
  },
  {
    version: "2.276.5",
    date: "2026-08-10",
    title: "The New issue window no longer follows you to another board",
    highlights: [
      {
        kind: "fix",
        text: "If you opened New issue on a board and then switched to a different board of the same kind without closing it, the window stayed on screen — still filling in an issue for the board you had just left, with the page behind it still locked from scrolling. Anything you submitted went to the old board's workflow rather than the one you were looking at. The window now closes when you move to another board or project, so what you see is always the board you are actually on.",
      },
    ],
  },
  {
    version: "2.276.4",
    date: "2026-08-10",
    title: "Database updates apply from a much smaller, faster package",
    highlights: [
      {
        kind: "improvement",
        text: "The component that applies database updates during an upgrade was shipping the entire application build alongside it — roughly 3 GB to run a single command. It now carries only the database tooling it actually uses, about seventeen times smaller. Upgrades transfer far less and start sooner, and there is less software sitting on the machine that touches your database. The update steps themselves are unchanged: all 134 of them were applied to a clean database and checked against their expected result before this shipped.",
      },
    ],
  },
  {
    version: "2.276.3",
    date: "2026-08-10",
    title: "Typefaces now ship with Cosmos instead of being fetched from Google",
    highlights: [
      {
        kind: "improvement",
        text: "The seven typefaces Cosmos uses are now included in the product itself rather than collected from Google while each update is prepared. Nothing looks different — the same fonts render exactly as before. What changes is that preparing an update no longer depends on Google serving the right file at the right moment, which had failed three times in one day and stopped updates from being built at all. Cosmos also no longer needs permission to contact Google's servers, so there is one less outside connection in the product.",
      },
    ],
  },
  {
    version: "2.276.2",
    date: "2026-08-10",
    title: "Updates build more reliably, and the download is smaller",
    highlights: [
      {
        kind: "improvement",
        text: "Preparing a new version used to download a 300 MB graphics-card component that Cosmos never uses, from a third-party site outside our control. When that site was slow or unreachable, the update simply could not be built. It is no longer fetched at all, so releases are quicker, noticeably smaller, and no longer depend on that server being up.",
      },
    ],
  },
  {
    version: "2.276.1",
    date: "2026-08-10",
    title: "The New issue type list now fits the project you are in",
    highlights: [
      {
        kind: "fix",
        text: "Creating an issue used to offer every work item type your organisation has ever defined — so a consulting project listed Permit, Safety Incident, Course and Production Order among dozens of options. The list now shows the types that belong to that project's kind of work, plus the general ones like Task and Risk that apply everywhere. Your own custom types are always shown, and nothing is narrowed when a project has no kind set, so you can never lose access to a type you need.",
      },
    ],
  },
  {
    version: "2.276.0",
    date: "2026-08-07",
    title: "Paid plugins can be unlocked by a signed licence",
    highlights: [
      {
        kind: "feature",
        text: "A plugin can now be marked as needing a licence, and switching it on requires a licence file issued by us — not a setting that anyone with database access could change. Licences are checked entirely on your own hardware: nothing is sent anywhere, and it works identically on a disconnected network. Nothing changes for the plugins you use today, because none of them require a licence yet.",
      },
    ],
  },
  {
    version: "2.275.2",
    date: "2026-08-05",
    title: "An uploaded logo now reaches the documents you export",
    highlights: [
      {
        kind: "fix",
        text: "A logo uploaded in organisation settings appeared everywhere in the app but was quietly missing from every PDF exported from it, with nothing to say it had been dropped. Exported documents now carry it. PNG and JPEG logos are drawn; a WebP or SVG logo still displays in the app but cannot be placed into a document, so those exports are unchanged.",
      },
    ],
  },
  {
    version: "2.275.1",
    date: "2026-08-05",
    title: "Exported documents follow the brand the app is already showing",
    highlights: [
      {
        kind: "fix",
        text: "PDFs exported from a branded deployment came out in plain greyscale unless someone had explicitly re-picked the organisation's look in settings — even though every screen in the app was already showing the brand. Exports now inherit the same brand the app is running, so a document matches the page it came from. Deployments with no brand of their own are unchanged and still export neutral.",
      },
    ],
  },
  {
    version: "2.275.0",
    date: "2026-08-05",
    title: "Project status is a real field, and Finance can show delivery revenue",
    highlights: [
      {
        kind: "feature",
        text: "A project's status was free text, so “Active”, “active” and “in progress” could all sit in the same column and none of them could be filtered or grouped. Status is now a proper field with four values — Draft, Active, On hold and Complete — and existing projects were converted automatically, whatever spelling they were using.",
      },
      {
        kind: "improvement",
        text: "Archiving stays separate from status, so a project can be archived whatever stage it had reached. Previously “archived” competed with the other values and a project could only be one or the other.",
      },
      {
        kind: "feature",
        text: "The Finance page can now carry a revenue panel contributed by an installed add-on, showing fee, time logged, invoiced and paid per project alongside the ledger. It reads the same figures as the schedule, so the two can never disagree.",
      },
    ],
  },
  {
    version: "2.274.0",
    date: "2026-08-05",
    title: "Clients are records now, not text typed onto each project",
    highlights: [
      {
        kind: "feature",
        text: "A project's client was free text, so two spellings of the same firm were two different clients and nothing could be grouped or filtered by them. Clients are now records you pick from: rename one and every project follows, and a former client keeps its history rather than being deleted. Existing projects were matched to clients automatically, ignoring stray spacing and capitalisation.",
      },
      {
        kind: "improvement",
        text: "Projects without a client stay that way \u2014 internal and speculative work does not need one, and choosing a client is never forced before a project can exist.",
      },
    ],
  },
  {
    version: "2.273.0",
    date: "2026-08-05",
    title: "Notes on a project, not just on the things inside it",
    highlights: [
      {
        kind: "feature",
        text: "Risks, changes, blockers, milestones and deliverables could all carry notes and an activity trail; the project itself could not. You can now leave notes against a project directly, and they behave exactly like notes anywhere else \u2014 same history, same permissions.",
      },
    ],
  },
  {
    version: "2.272.0",
    date: "2026-08-05",
    title: "Choose a logo file in Settings",
    highlights: [
      {
        kind: "improvement",
        text: "The upload added in the last release had no way to reach it \u2014 Settings still only offered a URL box. There is now a file picker with a preview of the current logo, and the URL field stays for anyone who would rather point at an image they already host.",
      },
    ],
  },
  {
    version: "2.271.0",
    date: "2026-08-05",
    title: "Upload your organisation's logo instead of hosting it yourself",
    highlights: [
      {
        kind: "improvement",
        text: "Setting an organisation logo meant pasting a URL, which only worked if the image was already hosted somewhere public. You can now upload the file directly \u2014 PNG, JPEG, WebP or SVG, up to 2MB. It is stored alongside your other documents rather than on the web server, so it survives every update; the previous logo is cleaned up when you replace it.",
      },
    ],
  },
  {
    version: "2.270.0",
    date: "2026-08-05",
    title: "Records are no longer marked CUI unless you are a government tenant",
    highlights: [
      {
        kind: "fix",
        text: "Risks, deliverables, blockers and change requests were all being stamped 'CUI' (Controlled Unclassified Information) the moment they were created — in every organisation, including commercial ones that hold no such designation. Nothing in the app ever set that marking deliberately; it was simply the value new records started with, which made it easy to miss and wrong wherever it appeared. Classification is now something only government tenants carry. If that is not you, the field no longer applies and is not shown at all. Existing markings in government organisations are untouched, and any classification anyone deliberately chose is kept.",
      },
      {
        kind: "improvement",
        text: "A deliverable's owner is now a real person from your organisation rather than a typed-in name. That means an owner can be looked up, filtered on, and shown with their avatar, and it opens the door to notifying them. Owners recorded as free text are still readable and are left exactly as they were — nothing was guessed at or reassigned.",
      },
    ],
  },
  {
    version: "2.269.0",
    date: "2026-08-04",
    title: "Two Atelier accent colours corrected to their real values",
    highlights: [
      {
        kind: "fix",
        text: "The Atelier theme carried two accent colours that were stand-ins, picked to sit with the rest of the palette while the real specification wasn't available. Both are now the correct values. Nothing in the app draws on them yet, so no screen looks different today — but anything that uses them from here on will be right.",
      },
      {
        kind: "improvement",
        text: "In dark mode those two colours are lightened so they stay readable against the dark canvas. The specification defines a single value for each with no dark-mode variant, and one of them would have been too faint to read as given.",
      },
    ],
  },
  {
    version: "2.268.0",
    date: "2026-08-04",
    title: "Exported PDFs now look like they came from your organisation",
    highlights: [
      {
        kind: "improvement",
        text: "Contract and audit-log exports were drawn in plain Helvetica and flat greys no matter how your workspace was themed, so a PDF you handed to a client looked unrelated to the product it came out of. They now take their colour and typography from your organisation's theme.",
      },
      {
        kind: "feature",
        text: "An organisation logo you have uploaded is now printed at the top of exported PDFs. A logo you have linked to by web address is not — an export never reaches out to another server to fetch one.",
      },
      {
        kind: "improvement",
        text: "A theme whose text would be unreadable on white paper falls back to the plain look for exports, so a document is never delivered in ink you cannot read.",
      },
    ],
  },
  {
    version: "2.267.0",
    date: "2026-08-04",
    title: "The Atelier skin gets its own typeface, and selection is readable in dark mode",
    highlights: [
      {
        kind: "improvement",
        text: "Atelier — the pearl-and-midnight drafting look — was the only sector theme without a typeface of its own, so it quietly borrowed the default one and leaned on typographic tricks to feel like a drawing office. It now sets its own face, and reads as its own thing rather than a tinted version of everything else.",
      },
      {
        kind: "fix",
        text: "Selecting text in Atelier's dark mode painted dark ink on an undefined highlight, so the selection was effectively invisible. Selected text is now legible in both light and dark.",
      },
      {
        kind: "improvement",
        text: "Atelier carries two further accent colours, so themed artefacts have a fuller palette to draw on.",
      },
    ],
  },
  {
    version: "2.266.1",
    date: "2026-08-03",
    title: "A board assigned to a team is hidden everywhere, not just in the sidebar",
    highlights: [
      {
        kind: "fix",
        text: "Assigning a board to a team removed it from the project's board strip, but the board itself stayed readable to anyone who knew or guessed its address — through the API, a direct link, its columns and dashboard widgets, and by asking Cosmo to list the project's boards. All of those now apply the same rule the sidebar does, and answer \"not found\" rather than revealing that there is a board you are not on the team for.",
      },
      {
        kind: "improvement",
        text: "Project reporting is deliberately unaffected: completion figures still count every board, so two people looking at the same project read the same numbers whatever teams they belong to.",
      },
    ],
  },
  {
    version: "2.266.0",
    date: "2026-08-03",
    title: "Link a planning team to the organisation team it stands for",
    highlights: [
      {
        kind: "feature",
        text: "A PI Planning team can now say which of your organisation's teams it stands for. Edit a team and pick it under \"Stands for\" — objectives and risks raised in planning can then be traced back to the people who actually own the work, instead of living in a second, parallel list of teams.",
      },
      {
        kind: "improvement",
        text: "The picker only offers teams from projects you can open, so it cannot be used to discover the teams on a project restricted to its members. Teams belonging to a different project than the planning team are hidden, with a note saying how many and why.",
      },
    ],
  },
  {
    version: "2.265.5",
    date: "2026-08-02",
    title: "Contracts follow project access, and Cosmo edits what the app allows",
    highlights: [
      {
        kind: "fix",
        text: "Contracts attached to a project restricted to its team were listed to everyone who could read the CRM, along with their terms and value. Contracts now follow the project they belong to; contracts not tied to a project stay visible as before.",
      },
      {
        kind: "fix",
        text: "Asking Cosmo to create or change a KPI needed less permission than doing it in the app, so someone could make changes through the assistant that the screen would have refused. Every agent change now requires exactly what the equivalent screen requires.",
      },
      {
        kind: "improvement",
        text: "The reverse also held: a project manager without organisation-wide rights could edit their own project in the app but not through Cosmo. They can now do both.",
      },
    ],
  },
  {
    version: "2.265.4",
    date: "2026-08-02",
    title: "The meetings list respects project access",
    highlights: [
      {
        kind: "fix",
        text: "Meetings attached to a project restricted to its team were listed to everyone who could read meetings at all — including their notes and transcripts. The list now shows meetings on projects you can open, plus any meeting not tied to a project. This matches what Cosmo was already doing, so the two no longer disagree.",
      },
    ],
  },
  {
    version: "2.265.3",
    date: "2026-08-02",
    title: "Cosmo sees exactly what you see, and nothing more",
    highlights: [
      {
        kind: "fix",
        text: "Projects restricted to their team were restricted only in the app. Asking Cosmo could still surface their risks, blockers, deliverables, changes, objectives, goals, KPIs, milestones, boards, documents, meetings, intervals, tickets and ticket comments — and let you edit or delete them. Every agent tool now checks whether you can open the project, not merely whether it exists.",
      },
      {
        kind: "fix",
        text: "Asking Cosmo about work items searched every ticket in the organisation, including projects you are not on. It now searches only what you can open.",
      },
      {
        kind: "improvement",
        text: "When Cosmo cannot reach something, it now says so without guessing whether it is missing or simply out of your reach, and points you at an owner or admin — rather than insisting it does not exist.",
      },
    ],
  },
  {
    version: "2.265.2",
    date: "2026-08-02",
    title: "Saving works on sites served through a proxy on a custom port",
    highlights: [
      {
        kind: "fix",
        text: "Where the site is reached through a proxy on a port other than the usual one, every attempt to save was turned away as though it had come from a different site — creating, editing and deleting all failed, while merely reading a page looked fine. The check that guards against requests from other sites now takes the port into account, so these sites behave like any other.",
      },
    ],
  },
  {
    version: "2.265.1",
    date: "2026-08-02",
    title: "The assistant follows the same time-reading rules as the app",
    highlights: [
      {
        kind: "fix",
        text: "Asking the assistant about time entries could return everyone's hours — and their pay rates — to anyone who could open the chat, even though the time-tracking screen has shown you only your own since an earlier release. The assistant now applies exactly the same rules: you see the hours you are allowed to see, and rates only for your own entries or with finance access.",
      },
    ],
  },
  {
    version: "2.265.0",
    date: "2026-08-02",
    title: "Timesheets waiting on you, in one place",
    highlights: [
      {
        kind: "feature",
        text: "Time tracking now lists the weeks waiting on your approval, oldest first, with a button that opens each one. Until now the notification announcing a submission was the only way to reach it — read once, and then gone.",
      },
      {
        kind: "improvement",
        text: "The list appears only when something is actually waiting, and counts only the weeks you were asked to approve — not every week you happen to have permission over.",
      },
    ],
  },
  {
    version: "2.264.0",
    date: "2026-08-02",
    title: "See who has asked you to supervise them",
    highlights: [
      {
        kind: "improvement",
        text: "When someone asks you to be their supervisor, Accounting → Payroll now marks their row so you can find it, and marks their name in the supervisor picker so you know you are acting on the right request. Previously the notification was the only record, so once it was dismissed there was nothing to go back to.",
      },
    ],
  },
  {
    version: "2.263.1",
    date: "2026-08-02",
    title: "Pay rates stay behind finance permissions in exports too",
    highlights: [
      {
        kind: "fix",
        text: "The project workbook mirrored to SharePoint included a Cost Rate column for every staffed person, whatever the permissions of whoever triggered it — even though the staffing screen deliberately hides that column from the same people. Exports now follow the same rule as the screen: rates appear only for those with finance access.",
      },
    ],
  },
  {
    version: "2.263.0",
    date: "2026-08-02",
    title: "A timesheet needs a supervisor before it can be submitted",
    highlights: [
      {
        kind: "feature",
        text: "Submitting a week now requires a supervisor. Before this, a week from someone nobody supervised was accepted, routed to nobody in particular, and sat unapproved with no one aware of it.",
      },
      {
        kind: "feature",
        text: "If you have no supervisor, the Submit button opens a request instead of failing: choose one or more people who can approve time and they are notified. They still make the assignment — you cannot appoint your own approver.",
      },
      {
        kind: "improvement",
        text: "The time-tracking page now says plainly whether you can submit, and tells apart \"nobody supervises you\" (which you can fix by asking) from \"nobody in the organisation can approve time yet\" (which needs an owner or admin to grant the Reviewer / Approver role).",
      },
      {
        kind: "improvement",
        text: "Nobody is locked out by the new rule: it does not apply if you can approve your own time, if you have no employee record, or if your organisation has nobody who could supervise you.",
      },
    ],
  },
  {
    version: "2.262.1",
    date: "2026-08-02",
    title: "Notifications open the week they are about",
    highlights: [
      {
        kind: "fix",
        text: "Opening a notification about someone's submitted timesheet took you to the wrong week — a week earlier, with no hours in it — for anyone in a timezone behind UTC. The link now opens the week it refers to.",
      },
    ],
  },
  {
    version: "2.262.0",
    date: "2026-08-02",
    title: "Pages you cannot see are now pages you cannot open",
    highlights: [
      {
        kind: "fix",
        text: "Typing the address of a screen your role hides — Payroll, Finance, Banking, Tax, Invoices — used to open it anyway. No figures were ever exposed, because the data is checked separately, but the page itself should never have loaded. Those screens now show a clear \"no access\" message.",
      },
      {
        kind: "improvement",
        text: "Whether you may open a page is now decided by the same rule that decides whether it appears in your sidebar, so the two can no longer disagree.",
      },
      {
        kind: "fix",
        text: "Choosing supervisors opened a panel that was cut off by the employees table and pushed underneath it. It is now a proper dialog, with room for full names.",
      },
      {
        kind: "improvement",
        text: "Pay runs explain themselves: what a run actually does, what posting one means, and why to preview it first.",
      },
      {
        kind: "fix",
        text: "The supervisor picker told you nobody in the organisation could approve time, even right after you had granted somebody the Reviewer / Approver role. The real obstacle was that they had no employee record — it now names the person and says to add them.",
      },
      {
        kind: "feature",
        text: "Right-click any day in the week grid to edit or remove the hours on it, or to log more. Removing an entry previously existed only in List view, so fixing a day you had logged wrongly meant switching views to do it — the grid is where you spot the mistake, so it is now where you can fix it. Where a day holds several entries, each is named by its hours and description so you can tell them apart.",
      },
    ],
  },
  {
    version: "2.261.0",
    date: "2026-08-01",
    title: "Accounting pages now live at accounting addresses",
    highlights: [
      {
        kind: "improvement",
        text: "The Accounting menu served pages whose web address started with /finance, so the address bar and the breadcrumb trail disagreed with the menu you clicked. Finance, Banking, Payroll, Tax and Invoices now all sit under .../accounting/..., matching what the trail says. Existing links and bookmarks to the old addresses still work — they forward to the new ones.",
      },
      {
        kind: "improvement",
        text: "Invoices moved out of CRM and into Accounting, where people were already looking for it.",
      },
      {
        kind: "improvement",
        text: "The separate Accounting page is gone; its Reports, Journal and Chart of Accounts are now tabs on the Finance page. One less menu item to choose between, and the breadcrumb no longer reads \"Accounting › Accounting\".",
      },
    ],
  },
  {
    version: "2.260.1",
    date: "2026-08-01",
    title: "Point people at the right screen",
    highlights: [
      {
        kind: "fix",
        text: "The prompt shown to someone with no supervisor told them to ask for one under \"Finance → Payroll\". Payroll lives under Accounting, so the one actionable instruction in that message pointed at a menu that does not exist.",
      },
    ],
  },
  {
    version: "2.260.0",
    date: "2026-08-01",
    title: "You can open the timesheet you were asked to approve",
    highlights: [
      {
        kind: "fix",
        text: "If a week was sent to you for approval but you are not that person's supervisor, you were notified and then met an empty page — and the notification linked straight to it. You can now open and act on any timesheet routed to you.",
      },
      {
        kind: "improvement",
        text: "That visibility is limited to weeks still waiting on your decision. Once you approve or return one it lapses — being asked to approve somebody's week does not become standing access to their time.",
      },
    ],
  },
  {
    version: "2.259.0",
    date: "2026-08-01",
    title: "Put your whole team on payroll in one click",
    highlights: [
      {
        kind: "feature",
        text: "Accounting → Payroll now tells you how many people have no employee record and offers to create them all at once. Until now they had to be added one at a time, so organisations sat with a full member list and no employee records — which meant nobody could be given a supervisor and no timesheet had anywhere to go for approval.",
      },
      {
        kind: "improvement",
        text: "Everyone missing a record is pre-selected, and you can untick anyone who should not be on payroll — contractors, or people who do not book time. Running it again is safe: anyone who already has a record is left exactly as they are.",
      },
      {
        kind: "improvement",
        text: "ACTION NEEDED: new records are created with a cost rate of $0.00. No rate is ever guessed, because an invented one would quietly mis-state labor cost and contract burn. Set the real rates in the Employees table before your next pay run, or that time will be costed at zero.",
      },
    ],
  },
  {
    version: "2.258.0",
    date: "2026-08-01",
    title: "Managing a project no longer means approving everyone's time",
    highlights: [
      {
        kind: "improvement",
        text: "The Project Manager role no longer approves time. Running a project and signing off company hours are separate authorities — approved hours go to payroll, to a contract line and sometimes to an invoice — and bundling them meant that giving someone a project quietly made them an approver for the whole organisation. Project managers still see time; they no longer sign it off.",
      },
      {
        kind: "improvement",
        text: "Time approval now sits with whoever supervises the person, with organisation owners and admins, or with the Reviewer / Approver role — which exists so you can grant approval authority without also handing someone a project. ACTION NEEDED: nobody is given that role automatically, so assign it to the people who should be approving.",
      },
    ],
  },
  {
    version: "2.257.0",
    date: "2026-08-01",
    title: "Removing time now asks why — and says what really happens",
    highlights: [
      {
        kind: "feature",
        text: "Removing a time entry now asks you to confirm and to say why, with the common reasons — wrong day, duplicate, wrong project — as one-click choices. Until now it removed the entry the instant you clicked, and recorded no explanation at all.",
      },
      {
        kind: "improvement",
        text: "The action is called \"Remove\" rather than \"Delete\", and the dialog says plainly that the entry is kept in the record with your name, the time and your reason. It was never actually deleted — the wording just implied it was.",
      },
      {
        kind: "improvement",
        text: "A reason is now required by the system itself, not merely by the screen, so hours can never be removed without an explanation attached.",
      },
    ],
  },
  {
    version: "2.256.0",
    date: "2026-08-01",
    title: "More than one supervisor, and only people who can actually approve",
    highlights: [
      {
        kind: "feature",
        text: "An employee can now have several supervisors — a deputy covering leave, or a second lead on another programme. Every one of them is notified when a week is submitted, so a single approver being away no longer stalls a timesheet.",
      },
      {
        kind: "improvement",
        text: "Only people who can actually approve time are offered when you add a supervisor. Anyone already assigned stays listed even if they lack that permission, marked as such, so an existing arrangement is never silently lost — but new ones have to be someone the organisation has trusted with approvals.",
      },
      {
        kind: "improvement",
        text: "Supervisors are still set by someone with permission to manage people or payroll — never by the person being supervised — and every change is written to the audit log. Whoever is named is notified that they now approve that person's time.",
      },
      {
        kind: "improvement",
        text: "If you have no supervisor, the time-tracking page now says so plainly and tells you to ask your supervisor to add you, rather than letting you submit a week that reaches nobody.",
      },
      {
        kind: "fix",
        text: "Setting a supervisor no longer requires finance access. An HR or people admin can now run the org chart without also being able to see pay rates.",
      },
    ],
  },
  {
    version: "2.255.0",
    date: "2026-08-01",
    title: "Submitted timesheets now go to someone",
    highlights: [
      {
        kind: "feature",
        text: "Submitting a week now tells you who it went to. If your employee record names a supervisor it goes to them; otherwise it goes to everyone in your organisation who can approve time.",
      },
      {
        kind: "feature",
        text: "Approvers are notified the moment a timesheet is submitted, and you are notified when yours is approved or returned — with the reason it came back. Opening the notification takes you straight to that week.",
      },
      {
        kind: "feature",
        text: "The Submit button now says who the week is about to go to before you press it, and warns you plainly when nobody is set up to approve your time — so hours are never handed in to nobody.",
      },
      {
        kind: "improvement",
        text: "A submitted week shows who it is waiting on, not just that it was submitted. Everyone it was routed to is recorded on the timesheet as of the moment you submitted, so later changes to the org chart never rewrite who a past week was handed to.",
      },
      {
        kind: "fix",
        text: "An employee record listing itself as its own supervisor made that person's timesheet impossible to approve — they were barred from approving their own week, and nobody else was designated. Such a record is now correctly read as having no supervisor.",
      },
    ],
  },
  {
    version: "2.254.0",
    date: "2026-08-01",
    title: "One way to approve time, and an export that agrees with payroll",
    highlights: [
      {
        kind: "improvement",
        text: "Approving time now happens in exactly one place — a person's week, through the timesheet. A separate bulk endpoint could approve any set of entries directly, skipping the week's workflow and the check that you are actually the approver for those people. It had no users and has been removed.",
      },
      {
        kind: "fix",
        text: "The PM template export priced labour differently from payroll and contract burn, so the same hours produced a different figure depending on where you read it. All three now use the same calculation.",
      },
    ],
  },
  {
    version: "2.253.2",
    date: "2026-08-01",
    title: "Filter a board by estimate",
    highlights: [
      {
        kind: "feature",
        text: "Boards can be filtered by time estimate — under 4h, 4–8h, 1–3 days, over 3 days, or not yet estimated. The bands are working days rather than round numbers, and the control only appears when something on the board is estimated.",
      },
    ],
  },
  {
    version: "2.253.1",
    date: "2026-08-01",
    title: "Contract burn and payroll agree on the same hours",
    highlights: [
      {
        kind: "fix",
        text: "Contract burn — how much of a CLIN's funded value has been consumed — was calculated differently from payroll, so the same hours at the same rates produced two different figures. On 400 entries they differed by 22 cents, and the gap widened as entries accumulated. Both now price labour the same way, rounded to the cent per line as an invoice or a pay run does.",
      },
      {
        kind: "fix",
        text: "A time entry with no rate and no employee cost rate no longer makes a CLIN's burn unreadable; it counts as zero.",
      },
    ],
  },
  {
    version: "2.253.0",
    date: "2026-08-01",
    title: "Take back a timesheet you submitted by mistake",
    highlights: [
      {
        kind: "feature",
        text: "Submitted the wrong week, or spotted a missing entry straight after? A \"Withdraw\" button now sits next to a submitted week's status, and puts it back in your hands. Previously the only way out was asking your supervisor to return it, which recorded a rejection nobody had actually made.",
      },
      {
        kind: "improvement",
        text: "Withdrawing is not a rejection: no reason is recorded, the week simply goes back to Open, and resubmitting is clean. Once a supervisor has approved it the button is gone — at that point returning it is theirs to do.",
      },
    ],
  },
  {
    version: "2.252.3",
    date: "2026-07-31",
    title: "An issue's right-click menu says where it takes you",
    highlights: [
      {
        kind: "fix",
        text: "“Open in board” on an issue sounded like it would open the board that issue sits on, but it opens your default board for that project — an issue lives in a column, so it can appear on several boards at once. The entry now reads “Open project board”. To share a specific issue, use Copy link, which addresses the issue itself.",
      },
    ],
  },
  {
    version: "2.252.2",
    date: "2026-08-01",
    title: "Filter a board by milestone, blockers and points",
    highlights: [
      {
        kind: "feature",
        text: "Boards can now be filtered by milestone, by whether work is blocked, and by story points — including an explicit \"No estimate\" option for unestimated work. Points and milestones list only what's actually on the board.",
      },
    ],
  },
  {
    version: "2.252.1",
    date: "2026-07-31",
    title: "Breadcrumbs spell board names properly",
    highlights: [
      {
        kind: "fix",
        text: "The breadcrumb above a board wrote acronyms as ordinary words — “Okr View” next to a tab reading “OKR View”, and the same for the RAID Log, RFI Tracker, BOM Table, SLA Dashboard, Attendee CRM and seven others. Each now reads exactly as the board is named.",
      },
    ],
  },
  {
    version: "2.252.0",
    date: "2026-08-01",
    title: "Submit your week, and have it approved",
    highlights: [
      {
        kind: "feature",
        text: "Time is now submitted a week at a time, not an entry at a time. \"Submit week\" sits in the week header, and the week's status — Open, Submitted, Approved or Returned — is shown alongside it.",
      },
      {
        kind: "feature",
        text: "Supervisors can approve or return a report's week from the same screen: pick the person, review the week, then Approve or Return. Returning requires a reason, and that reason is shown to them on the week that came back.",
      },
      {
        kind: "improvement",
        text: "You cannot approve your own timesheet when you have a supervisor — that is theirs to do. If you have no supervisor, you can, because otherwise your hours could never be approved at all.",
      },
      {
        kind: "improvement",
        text: "Approving a week never revives entries you had removed from it, and a returned week clears its earlier approval rather than carrying a stale signature.",
      },
    ],
  },
  {
    version: "2.251.5",
    date: "2026-07-31",
    title: "Issue and schedule dates read the same everywhere",
    highlights: [
      {
        kind: "fix",
        text: "Comment and attachment dates on an issue, the updates feed, and the deliverable and schedule trackers are now written identically by the server and by your browser, so they can no longer disagree and pop a “Something went wrong” error.",
      },
    ],
  },
  {
    version: "2.251.4",
    date: "2026-07-31",
    title: "Board dates no longer risk an error on load",
    highlights: [
      {
        kind: "fix",
        text: "Sprint dates, backlog interval ranges, the table view's due dates and the dashboard activity feed are now written the same way by the server and by your browser. Previously the two could disagree and pop a “Something went wrong” error when a board first loaded.",
      },
    ],
  },
  {
    version: "2.251.3",
    date: "2026-08-01",
    title: "More ways to slice a board",
    highlights: [
      {
        kind: "feature",
        text: "Boards can now be filtered by status, work category, reporter and due date, alongside the existing lenses. Due date offers what you'd actually ask a board — overdue, due this week, due this month, or no date — rather than a calendar picker.",
      },
    ],
  },
  {
    version: "2.251.2",
    date: "2026-07-31",
    title: "Timesheet dates read the same everywhere",
    highlights: [
      {
        kind: "fix",
        text: "The date on a time entry is now formatted the same way everywhere it appears, so the list and the week grid can never show an entry on different days, and the column no longer risks the “Something went wrong” error that comes from the page and the server disagreeing about a date.",
      },
    ],
  },
  {
    version: "2.251.1",
    date: "2026-08-01",
    title: "A removed time entry stays removed",
    highlights: [
      {
        kind: "fix",
        text: "A time entry you had removed could still be submitted for approval, approved, and counted toward a contract's consumed budget — putting deleted hours back into billing without anyone seeing it happen. Removed entries are now excluded everywhere: approvals, pay runs, contract burn, the finance summary, exports, and anything the assistant reports about hours.",
      },
    ],
  },
  {
    version: "2.251.0",
    date: "2026-08-01",
    title: "Time entries keep their history",
    highlights: [
      {
        kind: "feature",
        text: "Deleting a time entry no longer erases it. The entry disappears from your timesheet exactly as before, but the record is kept — who removed it, when, and optionally why. A timekeeping record that can be silently deleted cannot be used to answer an audit, or to settle a billing dispute.",
      },
      {
        kind: "feature",
        text: "Every edit to a time entry is now recorded with the actual values — what it said before, what it says now, and who changed it. Previously the log only noted that \"hours changed\", which cannot answer \"changed from what?\".",
      },
      {
        kind: "improvement",
        text: "Hours are now grouped into pay periods, which is what approval, payroll and invoicing all work in. Existing entries were filed into the week they were already logged against; nothing moved.",
      },
    ],
  },
  {
    version: "2.250.5",
    date: "2026-08-01",
    title: "The Project Manager role fits its name",
    highlights: [
      {
        kind: "improvement",
        text: "The built-in Project Manager role no longer grants authority over every project in the organisation. It lets you create projects and fully run the ones you manage — settings, boards, sprints, milestones and the rest — while projects you're merely a member of behave like any other member's. Owners and admins are unchanged, and everyone keeps the ticket editing they already had.",
      },
    ],
  },
  {
    version: "2.250.4",
    date: "2026-07-31",
    title: "A calmer board filter bar",
    highlights: [
      {
        kind: "improvement",
        text: "The board filter bar now leads with what you reach for most — assignee, type, priority, label — and tucks the rest behind \"More filters\". Anything you've actually set stays visible: if a tucked-away filter is narrowing the board, the row opens itself and the button shows how many are active, so a filtered board never looks broken.",
      },
    ],
  },
  {
    version: "2.250.3",
    date: "2026-07-31",
    title: "No more “Something went wrong” on the projects list",
    highlights: [
      {
        kind: "fix",
        text: "Opening Projects could pop a “Something went wrong” error, caused by the “Updated” and due dates on project cards being formatted differently by the server and your browser. Those dates now read the same from both, so the error is gone.",
      },
    ],
  },
  {
    version: "2.250.2",
    date: "2026-07-31",
    title: "Filter a board by label",
    highlights: [
      {
        kind: "feature",
        text: "Boards now have a Label filter, on the Kanban and Sprint boards and the Timeline. Picking several labels widens the view — an item shows if it carries any of them. The menu lists only labels actually on the board, and hides itself when there are none.",
      },
    ],
  },
  {
    version: "2.250.1",
    date: "2026-07-31",
    title: "Time entries show the day they were logged",
    highlights: [
      {
        kind: "fix",
        text: "The time-tracking list showed every entry one day earlier than it was logged for anyone in a timezone behind UTC — so the same entry appeared on two different days depending on whether you looked at the list or the week grid. The list was the one that was wrong. Because the day decides which week and which pay period an entry belongs to, this affected more than appearances.",
      },
    ],
  },
  {
    version: "2.250.0",
    date: "2026-07-31",
    title: "Supervisors can see their team's time",
    highlights: [
      {
        kind: "feature",
        text: "Employees can now be given a supervisor, set on the employee record under Accounting → Payroll. A supervisor can then review a report's hours week by week from the time-tracking page, without being handed access to the whole organisation.",
      },
      {
        kind: "feature",
        text: "Time tracking has a \"whose time\" picker for anyone who can see more than their own. Your own time is always the default, and a colleague's week is read-only — you cannot log or edit hours on someone else's behalf.",
      },
      {
        kind: "fix",
        text: "Day and week totals now describe one person. Anyone able to see other people's entries — org admins, until now — had those hours silently added into their own weekly total.",
      },
      {
        kind: "improvement",
        text: "Supervisors see hours, not money. Rates on someone else's entry still require finance access, so confirming that a week was worked never reveals what anyone is paid.",
      },
      {
        kind: "improvement",
        text: "The supervisor picker will not offer anyone who already reports up through that person, so the org chart cannot be tangled into a loop.",
      },
    ],
  },
  {
    version: "2.249.22",
    date: "2026-07-31",
    title: "Your time entries are yours",
    highlights: [
      {
        kind: "fix",
        text: "The time-tracking list returned every entry in the organisation — including the rate on each one — to anyone who could open the page. Members and view-only users now see their own entries and nobody else's. Supervisors, finance and admins are unaffected.",
      },
      {
        kind: "fix",
        text: "Rates on other people's entries are now shown only with finance access. Your own rate is always visible to you.",
      },
      {
        kind: "improvement",
        text: "Filtering time by project now respects team-scoped project access, so the time list can no longer surface work on a project you cannot otherwise see.",
      },
    ],
  },
  {
    version: "2.249.21",
    date: "2026-07-31",
    title: "See a project's work by team",
    highlights: [
      {
        kind: "feature",
        text: "Boards can now be grouped into swimlanes by team, and a Team filter shows one team's tasking or all of it. Available on the Kanban and Sprint boards, and the Team filter on the Timeline/Gantt. The control only appears on projects that actually have teams.",
      },
      {
        kind: "improvement",
        text: "A team's work means the work assigned to its members, so it reflects your existing data with nothing to set up. Unassigned work sits under \"No team\", and someone on two teams has their items counted under both when filtering.",
      },
    ],
  },
  {
    version: "2.249.20",
    date: "2026-07-31",
    title: "A project's manager can actually run it",
    highlights: [
      {
        kind: "improvement",
        text: "Someone set as a Manager on a project can now manage it end to end — settings, boards, the PM dashboard, sprints, milestones, risks, deliverables, KPIs and the rest — without needing an org-wide admin role. Around 44 actions previously required org-level permission an ordinary member doesn't have.",
      },
      {
        kind: "fix",
        text: "A project-management permission granted through a job-function role no longer confers authority over every project in the org. It now applies where you are a manager of that project; org owners and admins are unchanged. Deleting a project remains with owners and admins.",
      },
    ],
  },
  {
    version: "2.249.19",
    date: "2026-07-31",
    title: "Project cards show the project's managers",
    highlights: [
      {
        kind: "fix",
        text: "A project card showed a single person under a \"Lead\" label, chosen in a way that could change on its own when more than one person qualified — and it preferred the Lead role, so a project's actual managers were hidden. Cards now show the project's managers, all of them, in a stable order.",
      },
    ],
  },
  {
    version: "2.249.18",
    date: "2026-07-31",
    title: "Limited-visibility projects are properly hidden",
    highlights: [
      {
        kind: "fix",
        text: "When a project's visibility is limited to its members, someone holding a Project Manager role no longer sees it across the org — that role is meant for running a project, not for reaching every project. Owners and org admins still see everything, as before.",
      },
      {
        kind: "fix",
        text: "Project counts now match what you can actually open. A hidden project was still included in the totals in the header and on the dashboard, so the number disagreed with the list beneath it.",
      },
    ],
  },
  {
    version: "2.249.17",
    date: "2026-07-31",
    title: "The milestone date field tells you when it isn't yours to set",
    highlights: [
      {
        kind: "fix",
        text: "When a milestone follows its linked work, its due date comes from that work — so typing a date into the edit dialog was saved and then immediately replaced, with nothing explaining why. The field is now read-only in that case and says what it follows. Turning Auto status off hands it straight back, no save required.",
      },
    ],
  },
  {
    version: "2.249.16",
    date: "2026-07-31",
    title: "A board can belong to a team",
    highlights: [
      {
        kind: "feature",
        text: "A project's boards can now be assigned to a team, so a board only appears for that team's members. Boards with no team stay shared with the whole project — which is every board today, so nothing changes until you assign one. Project managers and admins continue to see all of them.",
      },
    ],
  },
  {
    version: "2.249.15",
    date: "2026-07-31",
    title: "Project roles below Manager now mean something",
    highlights: [
      {
        kind: "improvement",
        text: "The Members picker has always offered Manager, Lead, Member and Viewer, but only Manager changed anything — someone set to Viewer could still edit. Viewer is now genuinely read-only within that project, and Lead can manage the project's boards without needing an org-wide grant. Member is unchanged, and nobody loses access they had.",
      },
    ],
  },
  {
    version: "2.249.14",
    date: "2026-07-31",
    title: "A milestone's date follows the work it tracks",
    highlights: [
      {
        kind: "fix",
        text: "A milestone created from a ticket kept whatever date it started with, even after you changed that ticket's planned end date — so the Milestones board and the issue disagreed. The milestone's date now follows its linked work, using the latest planned end where several items are linked. Milestones you manage by hand, and ones with no linked work, are unchanged.",
      },
    ],
  },
  {
    version: "2.249.13",
    date: "2026-07-31",
    title: "A project limited to its members is now hidden everywhere",
    highlights: [
      {
        kind: "fix",
        text: "A project limited to its members was hidden from the projects list and its own pages, but its work items still appeared in the org-wide Issues list, its filters and the activity feed — and its name could still be found through @-mention search or by asking the assistant to list projects. All of those now respect the limit. Org admins and the owner keep access, as before, and organisations with no limited projects are unaffected.",
      },
    ],
  },
  {
    version: "2.249.12",
    date: "2026-07-30",
    title: "One Milestone type in the Issues filter, not two",
    highlights: [
      {
        kind: "fix",
        text: "The Issues page offered “Milestone” twice in its Type filter, and one of them matched nothing — two different milestone types were being seeded under the same name. The unused one is gone, so there is a single Milestone to filter by. Nothing you have filed changes: the duplicate is only removed where no work item was using it.",
      },
    ],
  },
  {
    version: "2.249.11",
    date: "2026-07-30",
    title: "Copy link gives you the issue, and labels are editable after filing",
    highlights: [
      {
        kind: "fix",
        text: "“Copy link” on an issue copied a link to the project, not the issue — so pasting it left the reader on the board with no idea which ticket you meant. It now copies a link that opens that issue's details.",
      },
      {
        kind: "improvement",
        text: "Labels can be added, changed and removed from an issue's details. They could be set when the issue was created and never touched again, because the details panel had no label control at all.",
      },
    ],
  },
  {
    version: "2.249.10",
    date: "2026-07-30",
    title: "Member-only projects hold on three more screens",
    highlights: [
      {
        kind: "fix",
        text: "When a project is limited to its own members, three screens still answered for anyone in the organisation who held the matching permission — the project's own work-item list, and a key result's linked tickets and check-ins. They now apply the same members-only rule as everywhere else. No project is affected unless it has that limit switched on.",
      },
    ],
  },
  {
    version: "2.249.9",
    date: "2026-07-30",
    title: "Milestones stay in step across every screen that shows them",
    highlights: [
      {
        kind: "fix",
        text: "A milestone added, renamed, re-dated or deleted on the Milestones board did not update the PM Dashboard's Schedule until you reloaded — and a change made on Schedule did not reach the Milestones board or the Release Timeline. They are the same milestones, and every screen now updates as soon as any of them changes.",
      },
    ],
  },
  {
    version: "2.249.8",
    date: "2026-07-30",
    title: "Create and staff teams from a project's Members page",
    highlights: [
      {
        kind: "feature",
        text: "A project's Members page now has a Teams section: create a team, add people from the project onto it, mark a lead, and remove or delete as things change. Only a project manager or org admin can edit them; everyone else sees the teams read-only.",
      },
    ],
  },
  {
    version: "2.249.7",
    date: "2026-07-30",
    title: "Limiting a project to its members now actually hides it",
    highlights: [
      {
        kind: "fix",
        text: "Turning on “Limit to project members” hid the project from lists and blocked its data, but someone who navigated straight to the project could still open it and see its boards, milestones, risks and the rest. Every page of a limited project is now hidden from people who are not members. Org admins and the owner still keep access, as before.",
      },
    ],
  },
  {
    version: "2.249.6",
    date: "2026-07-30",
    title: "A limited project stays out of the analytics rollup too",
    highlights: [
      {
        kind: "fix",
        text: "A project limited to its members still appeared in the portfolio analytics rollup — its name, key and progress were visible to anyone who could read analytics, even though they could not open it. It is now excluded for people who cannot see the project. Organisations with no limited projects are unaffected.",
      },
    ],
  },
  {
    version: "2.249.5",
    date: "2026-07-30",
    title: "Dependency refresh, and no more “Invalid Date” in chart tooltips",
    highlights: [
      {
        kind: "fix",
        text: "Hovering a point on the analytics or KPI charts could show “Invalid Date” in the tooltip when a data point had no date. Those tooltips now leave the label blank instead.",
      },
      {
        kind: "improvement",
        text: "Routine update of 50 libraries to their latest compatible versions.",
      },
    ],
  },
  {
    version: "2.249.4",
    date: "2026-07-30",
    title: "Teams, and a switch to limit a project to its members",
    highlights: [
      {
        kind: "feature",
        text: "A project can now have teams, managed by its manager or an org admin, and Project Settings gains a Visibility switch. Turn it on and only the project's members can see it — plus org admins and the owner, who always keep access so a project cannot be locked away from the people who administer it. Use it for work a subcontractor or partner team should not see.",
      },
      {
        kind: "improvement",
        text: "Every project stays visible to the whole organisation until someone turns that switch on, so nothing changes for existing projects.",
      },
    ],
  },
  {
    version: "2.249.3",
    date: "2026-07-30",
    title: "Choose which boards your project shows by default",
    highlights: [
      {
        kind: "feature",
        text: "Project Settings has a new Default Boards section listing every board in the project with a switch. Turn one off — a Bug Tracker nobody needs, say — and it stops appearing in the board strip for the whole team. The board and everything in it are untouched, and anyone can bring it back for themselves from the strip's overflow menu.",
      },
    ],
  },
  {
    version: "2.249.2",
    date: "2026-07-30",
    title: "Intervals read top to bottom, and PIs fold away",
    highlights: [
      {
        kind: "fix",
        text: "The Intervals page listed everything newest-first, so Sprint 5 sat above Sprint 1 and a Program Increment's sprints read backwards. Intervals now run in order down the page, inside a PI as well as outside one.",
      },
      {
        kind: "feature",
        text: "A Program Increment can now be collapsed to tuck its sprints out of the way, and expanded again. PIs start expanded, so nothing disappears until you choose to fold it.",
      },
    ],
  },
  {
    version: "2.249.1",
    date: "2026-07-30",
    title: "Adding someone to a project tells you the truth",
    highlights: [
      {
        kind: "fix",
        text: "Adding a member to a project reported “Member added to project.” even when the request had failed — alongside the error, with the form cleared and no new member in the list. It now only confirms when the person was actually added, and keeps your selection if something goes wrong so you can retry.",
      },
      {
        kind: "improvement",
        text: "The top-level Team tab is now called Org, since it lists everyone in the organisation. Teams are a project-level concept now, and one word could not keep meaning both.",
      },
    ],
  },
  {
    version: "2.249.0",
    date: "2026-07-30",
    title: "See objectives delivered by Features, not just numbers",
    highlights: [
      {
        kind: "feature",
        text: "An objective can now be linked to the work items that deliver it, so a stakeholder reading a PI Objective can see the Features behind it rather than only a key-result number. Use “Link work items” on an objective’s menu on the OKR View board. The objective then shows how much of that delivery is done — “2/3 delivered” — next to its progress.",
      },
      {
        kind: "improvement",
        text: "An objective with no key results used to sit at 0% forever, whatever was happening underneath. It now reports the share of its linked delivery that is complete. Objectives that already have key results are unaffected: those still set the percentage, so no number you are reading today changes.",
      },
      {
        kind: "improvement",
        text: "Key-result and objective link pickers now offer Features first instead of listing every ticket in creation order. Project Settings → Delivery mapping changes that to any type you prefer, separately for key results and objectives. Nothing is hidden: every other type stays linkable, and links you already have are untouched.",
      },
    ],
  },
  {
    version: "2.248.2",
    date: "2026-07-30",
    title: "A project limited to its members is hidden everywhere, not just when opened",
    highlights: [
      {
        kind: "fix",
        text: "When a project is limited to its own members, that limit now holds across every one of its screens — boards, milestones, risks, deliverables, intervals, analytics — and the project no longer appears in the projects list or on the dashboard for people who cannot open it. Projects that are not limited behave exactly as before.",
      },
    ],
  },
  {
    version: "2.248.1",
    date: "2026-07-30",
    title: "Sprint planning asks the right people for capacity",
    highlights: [
      {
        kind: "fix",
        text: "Starting a sprint listed everyone in the organisation for capacity planning, including automated agents like Foreman — which were being asked for an allocation of points or hours they cannot have. Capacity now lists the people on that project only, and never bots.",
      },
      {
        kind: "improvement",
        text: "Projects can now have teams, and a project can be set so that only its members see it. Existing projects are unchanged: every project stays visible exactly as it is today until someone turns this on.",
      },
    ],
  },
  {
    version: "2.248.0",
    date: "2026-07-30",
    title: "Create objectives on Goals / Objectives, not just the OKR board",
    highlights: [
      {
        kind: "feature",
        text: "You can add an objective straight from the Goals / Objectives board — title, interval and committed-or-stretch — instead of having to go to the OKR View board for it. That board is optional, so on a project without it there was previously no way to create an objective at all, even though the section describing them was right there.",
      },
      {
        kind: "improvement",
        text: "The two boards now stay in step. They show the same objectives, and an objective created on either one appears on the other immediately rather than after a reload.",
      },
    ],
  },
  {
    version: "2.247.5",
    date: "2026-07-30",
    title: "Each line of effort listed once when you log PM work",
    highlights: [
      {
        kind: "fix",
        text: "The Branch picker repeated the LOE number — “LOE1 LOE 1 — Authorize, Cloud & Data” — in the New Change Request, New Blocker, New Deliverable and New Schedule Item dialogs. It read correctly when editing an existing row, so only the dialog that creates the record was affected. Every line of effort is now named once, everywhere.",
      },
    ],
  },
  {
    version: "2.247.4",
    date: "2026-07-30",
    title: "Clearer empty state on Goals / Objectives",
    highlights: [
      {
        kind: "fix",
        text: "The Objectives section named the wrong board when a project had none, and ran two words together. It now points at the OKR View board by name.",
      },
    ],
  },
  {
    version: "2.247.3",
    date: "2026-07-30",
    title: "You can actually set an objective's interval and commitment now",
    highlights: [
      {
        kind: "fix",
        text: "PI Objectives shipped without a way to create one. An objective could be tied to an interval and marked committed or uncommitted in the data, but no screen offered either field — so the feature was unreachable. The OKRs board now has an interval picker and an “Uncommitted (stretch)” checkbox, on both the create row and the edit dialog.",
      },
      {
        kind: "fix",
        text: "The Objectives section on the Goals / Objectives board rendered nothing at all when a project had no objectives, so there was no sign the feature existed and no hint where objectives are created. It now says so, and points at the OKRs board.",
      },
    ],
  },
  {
    version: "2.247.2",
    date: "2026-07-29",
    title: "A comment box that starts small, and activity that names the sprint",
    highlights: [
      {
        kind: "improvement",
        text: "The comment box on a ticket opened as a 300-pixel-tall empty rectangle — it was borrowing its shape from the full-page note editor. It now rests at about two lines, grows as you write, and scrolls in place once it is tall enough, so a one-line reply no longer leaves a crater in the detail panel and a long one is still comfortable to write. Editing a posted comment behaves the same way, and so does the comment box in the PM dashboard's side panel.",
      },
      {
        kind: "fix",
        text: "Activity for a sprint change read “changed interval to Unknown” instead of naming the sprint you moved the item into. The Activity page now names the sprint — and the status lane, the person and the work-item type — behind every change. A ticket's own Activity tab had the same gap for type changes and is fixed too.",
      },
      {
        kind: "improvement",
        text: "When a change points at something since deleted, activity no longer invents a value: it says what changed and leaves the value out rather than claiming “Unknown”. The home dashboard's Recent activity widget also stopped showing raw database column names like “intervalId”.",
      },
    ],
  },
  {
    version: "2.247.1",
    date: "2026-07-29",
    title: "Ticket links open again, and a tidier risk register",
    highlights: [
      {
        kind: "fix",
        text: "Clicking a link to a ticket — from the Activity feed, a mention, or a shared URL — dropped you on the Issues list instead of opening the ticket. It now opens. If the ticket has since been deleted, or isn't one you have access to, you get told so rather than being left wondering.",
      },
      {
        kind: "improvement",
        text: "The risk register no longer asks for a Branch. It wasn't doing anything useful on a risk, and the picker was showing each LOE's number twice — \"LOE1 LOE 1 — …\". The other PM registers that still use Branch now show it once.",
      },
      {
        kind: "improvement",
        text: "A risk's Owner is now picked from your members instead of typed in by hand, so risks can't end up assigned to a misspelling.",
      },
    ],
  },
  {
    version: "2.247.0",
    date: "2026-07-29",
    title: "PI Objectives and sprint goals, next to your project goals",
    highlights: [
      {
        kind: "feature",
        text: "An objective can now belong to an interval — a Program Increment or a sprint — and be marked committed or uncommitted. Uncommitted is SAFe's stretch objective: planned for, deliberately not promised, and not counted toward what the PI is accountable for.",
      },
      {
        kind: "feature",
        text: "The Goals board is now Goals / Objectives, and lists those objectives grouped under the interval they belong to, with a count of what's committed to each. A sprint's own goal appears at the head of its group — until now it was only visible inside that sprint's settings.",
      },
      {
        kind: "improvement",
        text: "Deleting a Program Increment leaves its objectives in place, simply untimeboxed, rather than deleting them along with it — the same way deleting a PI already leaves its sprints alone.",
      },
    ],
  },
  {
    version: "2.246.3",
    date: "2026-07-29",
    title: "One Milestone, not two, in Client Engagement projects",
    highlights: [
      {
        kind: "fix",
        text: "Client Engagement projects offered two different “Milestone” types in the New issue dialog. Only one of them was ever a real milestone — the other created an ordinary work item that never reached the Milestones board, the Release Timeline or the Gantt. The duplicate is no longer offered. Anything already filed as one keeps its type and stays exactly where it is, and can now be retyped.",
      },
    ],
  },
  {
    version: "2.246.2",
    date: "2026-07-29",
    title: "Every project template now switches on the features it promises",
    highlights: [
      {
        kind: "fix",
        text: "Projects started from the Construction, Client Engagement, Course, Event, Production Run and Operations templates had no Intervals button, even though each of those templates defines its own kind of interval — Phases, Modules, Days, Runs and Releases. Intervals are now switched on for all of them, on existing projects as well as new ones.",
      },
      {
        kind: "fix",
        text: "Those same templates listed Risks, Decisions and Meeting Notes as enabled features, none of which were real settings — so they quietly did nothing. Construction, Client Engagement, Production Run and Operations projects now get a working Risk Register on the PM Dashboard instead. If you had already changed a project's features yourself, your choices are left exactly as you set them.",
      },
      {
        kind: "improvement",
        text: "The template editor under Settings offered the same three features that did nothing, and hid the ones that work. It now lists every feature a project can actually turn on, including the Roadmap, Files and the full PM Dashboard suite.",
      },
    ],
  },
  {
    version: "2.246.1",
    date: "2026-07-29",
    title: "Project boards now honour access policies",
    highlights: [
      {
        kind: "fix",
        text: "If your organisation used an access policy to keep someone out of a project's work, the org-wide Issues list respected it but the project's own board did not — the items were still readable by opening the project directly. The board now applies the same policy as everywhere else. Organisations with no such policies see no change.",
      },
    ],
  },
  {
    version: "2.246.0",
    date: "2026-07-29",
    title: "One “New issue” form, on every board",
    highlights: [
      {
        kind: "improvement",
        text: "Which details you could fill in when creating an issue depended on where you happened to be standing: the Table, Backlog, Timeline, Calendar and RAID boards offered a cut-down form with no description, story points, labels or custom fields, and the Kanban's per-column “Add card” could only set a title. Every board now opens the same full New issue form the Issues page uses.",
      },
      {
        kind: "feature",
        text: "That form now has a Status picker, so you choose where a new issue lands instead of it silently going to the first column of the project's first board. On a board it offers that board's own statuses; on Timeline, Calendar and RAID — which have no workflow of their own — it offers the project's.",
      },
      {
        kind: "improvement",
        text: "The per-column “Add card” buttons are gone from the Kanban and Scrum boards; “New issue” in the toolbar above replaces them. New RAID entries still arrive pre-categorised, now as an editable label.",
      },
      {
        kind: "feature",
        text: "Right-clicking an issue on the Issues page now offers the changes you actually make most often — assign it to someone, set its status, move it into a sprint or PI, or change its priority — each as a submenu with a tick against its current value. Statuses and sprints are the ones belonging to that issue's own project.",
      },
    ],
  },
  {
    version: "2.245.0",
    date: "2026-07-29",
    title: "Plan into any sprint, and move between them from the board",
    highlights: [
      {
        kind: "fix",
        text: "On the Backlog, a sprint only appeared once something was already in it — so a sprint you had just created had nowhere to drop onto, and there was no way to drag work into it. Every sprint you can still plan into now has its own section, empty or not. Finished sprints stay listed only while they still hold work, so the list keeps to what you're actually planning.",
      },
      {
        kind: "improvement",
        text: "The sprint buttons along the top of a Scrum board now switch the board to that sprint, instead of opening a panel that just described it. There's an “All items” button to come back out to everything, and the sprint summary above — dates, goal, progress, and the velocity and carry-over of a finished sprint — follows whichever one you're looking at.",
      },
    ],
  },
  {
    version: "2.244.2",
    date: "2026-07-29",
    title: "Milestones filed as work items now reach the Milestones board",
    highlights: [
      {
        kind: "fix",
        text: "Anything created as a “Milestone” from a board's New issue dialog became a work item, so it never showed on the Milestones board, the Release Timeline or the PM dashboard. Those now have real milestones, dated and ordered as you filed them, and the original ticket stays put — with its comments and history — linked to the milestone it created.",
      },
      {
        kind: "improvement",
        text: "Because the ticket stays linked, the milestone tracks it: move the ticket to Done and the milestone reads as complete. A “Milestone” item with no due date is left alone rather than given an invented date — add a due date and it can be converted.",
      },
    ],
  },
  {
    version: "2.244.1",
    date: "2026-07-29",
    title: "Timeline: pick your work items straight off the chart",
    highlights: [
      {
        kind: "fix",
        text: "The gear beside the Critical path button opens its settings again. Clicking it used to drop the whole board into an error screen, which made choosing what counts as critical impossible to reach.",
      },
      {
        kind: "feature",
        text: "Click a bar in the chart to select that work item, so you can aim the Shift buttons without hunting for its row. Ctrl/Cmd-click adds or removes one, and Shift-click takes everything in between. Double-click or right-click a bar to open the ticket, and dragging still reschedules exactly as before.",
      },
      {
        kind: "improvement",
        text: "Shift-click the work-item checkboxes to select a whole range at once, instead of ticking every row one at a time. It picks up from the last row you clicked and only ever covers rows you can actually see.",
      },
      {
        kind: "improvement",
        text: "The work-items checkboxes now sit in their own column and stay out of the way until you hover a row or start selecting, so the list reads as tickets first.",
      },
    ],
  },
  {
    version: "2.244.0",
    date: "2026-07-29",
    title: "A Timeline / Gantt you can actually drive",
    highlights: [
      {
        kind: "feature",
        text: "Zoom in and out of the timeline — buttons, a percentage that resets to 100% when clicked, and Ctrl/Cmd + scroll over the chart. The work-items column text scales with it. Ordinary scrolling still scrolls.",
      },
      {
        kind: "feature",
        text: "A fullscreen view showing just the work items and the calendar, with everything else out of the way. Escape leaves it.",
      },
      {
        kind: "feature",
        text: "You choose what the Critical Path means. The gear beside the button offers the chain with the most dependencies, the longest duration, the latest finish, or the most overdue and blocked work — and can dim everything off the path so it stands out.",
      },
      {
        kind: "improvement",
        text: "Shift now moves only the work items you tick, instead of every item on the board at once. With nothing selected the Shift buttons stay disabled rather than quietly moving everything.",
      },
      {
        kind: "improvement",
        text: "Removed the Compress and Expand buttons. They looked like view controls but rewrote every visible item's dates, so “see a wider window” and “move everyone's plan” were the same click. Zoom replaces them without touching your schedule.",
      },
    ],
  },
  {
    version: "2.243.3",
    date: "2026-07-29",
    title: "Fixes for creating and classifying work",
    highlights: [
      {
        kind: "fix",
        text: "On the Timeline / Gantt, Calendar, RAID Log and Roadmap boards, the “New issue” dialog opened with Status empty and “Create issue” greyed out, so nothing could be created from them. Those boards define no statuses of their own; the dialog now offers the project's statuses.",
      },
      {
        kind: "improvement",
        text: "“Milestone”, “Goal”, “KPI”, “Objective”, “Key Result” and “Risk” are no longer offered as issue types when creating work. Each of those is a real thing in its own right with its own board, and an issue filed as one never appeared there — a “milestone” created this way never reached the Milestones board. Existing items are untouched and still editable.",
      },
      {
        kind: "fix",
        text: "The Type column on the Issues page showed an icon's internal name next to the type — “CheckSquare Task”, “Layers Feature”. It now shows the icon.",
      },
    ],
  },
  {
    version: "2.243.2",
    date: "2026-07-28",
    title: "Milestones show up on the Timeline / Gantt",
    highlights: [
      {
        kind: "fix",
        text: "Milestones did not appear on the Timeline / Gantt, and the diamonds it did show were ordinary work items that happened to start and finish on the same day. The Gantt now shows your real milestones — the same ones on the Milestones board — and clicking one opens it there, so it is edited in a single place.",
      },
      {
        kind: "improvement",
        text: "A project now has one kind of milestone. The Roadmap could previously hold its own separate “milestone” entries, which never had a date and never appeared on any schedule; those have been retired so a milestone means the same thing on every board.",
      },
    ],
  },
  {
    version: "2.243.1",
    date: "2026-07-28",
    title: "Restores the Intervals button on affected software projects",
    highlights: [
      {
        kind: "fix",
        text: "Software projects created before the template was corrected had no Intervals button in the project header, and the last fix only reached projects using an older internal setting — so some were left without it. Those projects now get the full set of features the template was meant to give them, including Intervals. A project whose features were changed by hand is left exactly as configured.",
      },
    ],
  },
  {
    version: "2.243.0",
    date: "2026-07-28",
    title: "Labels you can actually manage",
    highlights: [
      {
        kind: "feature",
        text: "Labels are now managed in one place. “Manage labels” on the Issues page lists every label in your organization with how many work items use it, and lets you rename, merge or delete one across every project at once — none of which was possible when a label was just text typed onto a ticket.",
      },
      {
        kind: "improvement",
        text: "“Security”, “security” and “SECURITY” were three separate entries in every label filter. They are now one label, and existing tickets were converted automatically — the spelling your organization used most is the one kept.",
      },
      {
        kind: "improvement",
        text: "Renaming a label onto one that already exists merges them, and tells you how many items moved.",
      },
    ],
  },
  {
    version: "2.242.0",
    date: "2026-07-28",
    title: "Edit a ticket from wherever you found it",
    highlights: [
      {
        kind: "feature",
        text: "The Issues page now opens the same full editor the boards use. Previously a ticket opened there was read-only, so making any change meant finding it again on a board — you can now edit it where you found it.",
      },
      {
        kind: "feature",
        text: "Tickets on the Table, Calendar and RAID boards are now clickable and open that same editor. On the Calendar and RAID boards they had been display-only.",
      },
      {
        kind: "feature",
        text: "A ticket's type can be changed after it is created — a Story that turns out to be a Bug, or a Task that grows into a Feature, no longer has to be recreated.",
      },
      {
        kind: "fix",
        text: "A wide table or code block in a description used to drag the whole ticket panel sideways, pushing the fields out of view. Wide content now scrolls on its own.",
      },
    ],
  },
  {
    version: "2.241.1",
    date: "2026-07-28",
    title: "Fixes losing your work when editing a ticket",
    highlights: [
      {
        kind: "fix",
        text: "Typing a ticket description and then changing any other field on it — status, assignee, priority, sprint — discarded what you had typed and put the previously saved text back. Your in-progress edits are now kept.",
      },
      {
        kind: "fix",
        text: "Projects created before the last release still showed a board named “Sprint Dashboard”. Those are renamed to “Sprint Health”; a board you renamed yourself is left alone.",
      },
    ],
  },
  {
    version: "2.241.0",
    date: "2026-07-28",
    title: "New software projects get the current template",
    highlights: [
      {
        kind: "fix",
        text: "A new Software Project was still being created from an older template — a board called “Sprint Dashboard” instead of “Sprint Health”, and no Intervals button in the project header. New projects now get the current set of boards and features.",
      },
      {
        kind: "fix",
        text: "Fixed a case where changing any project feature could permanently remove the Intervals button from projects created before that feature was renamed.",
      },
    ],
  },
  {
    version: "2.240.3",
    date: "2026-07-27",
    title: "Add-on updates now reach organizations already using them",
    highlights: [
      {
        kind: "fix",
        text: "When an add-on shipped new setup — the eight new PI Planning roles, for instance — organizations that already had it enabled kept the old set until an admin happened to toggle it in Settings. Those updates now apply on their own, so the new roles appear where they were expected.",
      },
    ],
  },
  {
    version: "2.240.2",
    date: "2026-07-27",
    title: "Restores the build, delivering the PI Planning improvements",
    highlights: [
      {
        kind: "fix",
        text: "The last two releases failed to build, so the PI Planning role and editing improvements never reached instances. Nothing was lost — each release stopped before deploying anything. This fixes the build and delivers them.",
      },
    ],
  },
  {
    version: "2.240.1",
    date: "2026-07-27",
    title: "Fixes a build failure that blocked the previous release",
    highlights: [
      {
        kind: "fix",
        text: "The 2.240.0 image failed to build, so the PI Planning role and editing improvements never reached instances. Nothing was lost — the release simply stopped before deploying. This restores the build.",
      },
    ],
  },
  {
    version: "2.240.0",
    date: "2026-07-27",
    title: "PI Planning: roles for the whole team, and nothing you can't edit",
    highlights: [
      {
        kind: "feature",
        text: "Eight more SAFe roles — Developer, Tester/QA, Business Analyst, UX Designer, DevOps/System Team, Agile Coach, Epic Owner and Solution Train Engineer. The previous six covered leadership only, which left most of the people actually in the room with no role to hold. Organizations already using PI Planning get the new roles automatically.",
      },
      {
        kind: "improvement",
        text: "Anything you create during an event can now be corrected. Cards can be renamed and annotated, risks can be re-titled and re-scored after they're raised, and a confidence vote opened by mistake can be relabelled or discarded. Re-scoring a risk recalculates its level, and leaves your Resolved/Owned/Accepted/Mitigated decision alone.",
      },
    ],
  },
  {
    version: "2.239.0",
    date: "2026-07-27",
    title: "PI Planning: run the event to a clock, and break out by team",
    highlights: [
      {
        kind: "feature",
        text: "Planning events now have an agenda and a timer. Load the standard SAFe two-day running order in one click or build your own, then start, pause and complete each segment — everyone in the event sees the same countdown, and overrunning is shown rather than enforced.",
      },
      {
        kind: "feature",
        text: "A team breakout view shows one team's plan on its own: their features by iteration, their objectives and predictability, their risks, and what still stands in the way of committing — without the rest of the train competing for the screen.",
      },
      {
        kind: "feature",
        text: "Export an event for people who don't use Cosmos: a Markdown summary of the whole plan, or the objectives, risks and board as spreadsheets.",
      },
      {
        kind: "feature",
        text: "Start a new PI from the last one. It carries over the setup you'd otherwise retype — the same teams, projects, iteration columns and agenda — and none of the previous PI's features, objectives or risks, which belong to that PI's record.",
      },
    ],
  },
  {
    version: "2.238.0",
    date: "2026-07-27",
    title: "PI Planning: see who's in the room, and right-click anything",
    highlights: [
      {
        kind: "feature",
        text: "A planning event now shows everyone currently in it, which section they're on, and what they have open — so you can tell at a glance whether the teams have arrived, and whether someone else is already editing the objective you were about to change.",
      },
      {
        kind: "feature",
        text: "Right-click any card, objective, risk, team or event for the actions it supports. On the program board this includes moving a feature to another iteration or team by name, which drag-and-drop can't do once the board is wide enough to scroll — and can't do at all from a keyboard.",
      },
      {
        kind: "feature",
        text: "New to PI Planning? \"Load reference event\" builds a complete worked example — a filled program board, objectives with business value, ROAM'd risks and a closed confidence vote — clearly badged as sample data and removable in one click.",
      },
    ],
  },
  {
    version: "2.237.5",
    date: "2026-07-27",
    title: "PI Planning: the confidence vote now works on existing instances",
    highlights: [
      {
        kind: "fix",
        text: "Running a confidence vote in PI Planning failed on organizations that enabled the add-on before the feature shipped, because part of its storage was never created for them. Existing events, objectives and risks are unaffected — nothing was lost, and the vote now opens, collects and closes normally.",
      },
    ],
  },
  {
    version: "2.237.4",
    date: "2026-07-27",
    title: "Turning on an add-on now takes you straight to it",
    highlights: [
      {
        kind: "fix",
        text: "Enabling an add-on under Settings → Plugins now adds it to your sidebar immediately. Previously the switch flipped but the link only appeared after a full page reload, which made it look as though the add-on had failed to install.",
      },
    ],
  },
  {
    version: "2.237.3",
    date: "2026-07-27",
    title: "Releases now reach your instance automatically",
    highlights: [
      {
        kind: "fix",
        text: "Updates published to Cosmos now roll out to your instance on their own. Previously a release could be built and then quietly never installed, leaving you on an older version with nothing to indicate anything had gone wrong.",
      },
    ],
  },
  {
    version: "2.237.2",
    date: "2026-07-26",
    title: "Plugins: add-ons can now ship their own libraries",
    highlights: [
      {
        kind: "improvement",
        text: "Optional capability bundles under Settings → Plugins can now bring the software libraries they need with them, so richer add-ons — collaborative, realtime surfaces among them — can be offered to your organization. Nothing changes for plugins you have already enabled.",
      },
    ],
  },
  {
    version: "2.237.1",
    date: "2026-07-25",
    title: "Accessibility: copy-token button now announced to screen readers",
    highlights: [
      {
        kind: "fix",
        text: "The copy button next to a newly created API key now has an accessible name, so screen readers announce it as “Copy API token” (and “Copied” after you copy) instead of just “button”.",
      },
    ],
  },
  {
    version: "2.237.0",
    date: "2026-07-24",
    title: "Plugins: opt-in capability bundles per organization",
    highlights: [
      {
        kind: "feature",
        text: "New Settings → Plugins tab: organization admins can enable, disable, and configure optional capability bundles for their org. Plugins are off until you turn them on, and disabling one hides its surfaces while keeping its data so re-enabling restores everything.",
      },
    ],
  },
  {
    version: "2.236.0",
    date: "2026-07-24",
    title: "Comments: rich mention input (name chips, not raw tokens)",
    highlights: [
      {
        kind: "improvement",
        text: "The comment box (new and edit) is now a rich editor like Notes — @-mention someone and you see their name as a chip while composing, instead of a raw <@…> token. Posting is unchanged; existing comments still render correctly.",
      },
    ],
  },
  {
    version: "2.235.2",
    date: "2026-07-24",
    title: "Fix: names (not UUIDs) in Table group headers",
    highlights: [
      {
        kind: "fix",
        text: "Grouping the Table view by Assignee (or Type, Status, Interval) now shows the person's name, the type/status name, etc. in the group headers — previously the raw UUID/key was shown. Empty groups read “Unassigned”/“No type”.",
      },
    ],
  },
  {
    version: "2.235.1",
    date: "2026-07-24",
    title: "New Board: discipline tabs for the sector presets",
    highlights: [
      {
        kind: "improvement",
        text: "The New Board gallery now has category tabs for each discipline — Construction, Consulting, Education, Events, Manufacturing, Operations — so the sector presets are browsable by field instead of crowding the Tracking tab. The functional tabs (Agile, Planning, Analytics, …) keep the generic board types.",
      },
    ],
  },
  {
    version: "2.235.0",
    date: "2026-07-24",
    title: "Every board preset available in New Board",
    highlights: [
      {
        kind: "feature",
        text: "The New Board gallery now offers all the preset boards from every project type — RFI Tracker, Submittal Log, Deliverable Tracker, Vendor Tracker, Work-Order Kanban, Incident Board, Grading Board, and more (32 in all) — not just your project type's. They slot into the existing category tabs, so any team can adopt another discipline's board when it's useful. Kanban presets bring their column setup.",
      },
    ],
  },
  {
    version: "2.234.0",
    date: "2026-07-24",
    title: "Intervals: consistent label, project-type default kind",
    highlights: [
      {
        kind: "improvement",
        text: "The project header entry now reads “Intervals” for every project type, instead of a per-type label. The project's sector still drives the DEFAULT kind pre-selected when you create one (Sprint for software, Phase for construction/consulting, Module for education, Run for manufacturing, Release for ops, Event Day for events) — and every kind remains available in the picker.",
      },
    ],
  },
  {
    version: "2.233.2",
    date: "2026-07-24",
    title: "Filter bar shows only the custom-field filters in use",
    highlights: [
      {
        kind: "improvement",
        text: "The Timeline and Kanban filter bar now shows a custom-field filter (e.g. Repro steps, Release version, Environment, Severity) only when items on that board actually use it — so bug-specific fields no longer clutter a board full of stories and tasks. An active filter stays visible so you can always clear it.",
      },
    ],
  },
  {
    version: "2.233.1",
    date: "2026-07-24",
    title: "Fix: Sprints nav link + wider Manage-sprints drawer",
    highlights: [
      {
        kind: "fix",
        text: "Restored the top-level Sprints link in the project header — the cycle→interval rename accidentally changed an internal feature-flag key, hiding it. The internal key is a stored identifier and stays as-is; only the user-facing wording changed.",
      },
      {
        kind: "fix",
        text: "The Manage-sprints drawer on the Sprint Board now opens to a comfortable width instead of a narrow strip.",
      },
    ],
  },
  {
    version: "2.233.0",
    date: "2026-07-24",
    title: "“Cycles” are now “Intervals”",
    highlights: [
      {
        kind: "improvement",
        text: "Renamed the generic time-boxed container from “cycle” to “interval” across the whole app. An interval is the umbrella term for a Sprint, Phase, Program Increment, Release, and the other kinds — the old “cycle” wording implied it was one specific kind. Your data and sprints are unchanged; it's the same feature with clearer, kind-neutral naming (per-sector labels like “Sprints” still apply where a project uses them).",
      },
    ],
  },
  {
    version: "2.232.0",
    date: "2026-07-23",
    title: "Roll straight into the next sprint on completion",
    highlights: [
      {
        kind: "feature",
        text: "When you complete a sprint, you're now offered a pre-filled next sprint — same duration, incremented name, inheriting the same Program Increment — so you can start the following sprint in one click. Edit the details or skip it entirely.",
      },
    ],
  },
  {
    version: "2.231.0",
    date: "2026-07-23",
    title: "Sprints: cleaner navigation + manage-in-context",
    highlights: [
      {
        kind: "improvement",
        text: "Sprints moved off the crowded board tab strip. There's now a top-level Sprints link in the project header, and a Manage button on the Sprint Board opens a drawer with the full sprint lifecycle (create/start/complete) so you can run sprints without leaving the board.",
      },
      {
        kind: "improvement",
        text: "Renamed the “Sprint Dashboard” board to “Sprint Health” — it's a health/metrics view (workload, burn rate, status), not a management surface.",
      },
      {
        kind: "fix",
        text: "Sprint date ranges in the Sprint Board detail popup now show the exact calendar days entered (previously a day early in western timezones).",
      },
    ],
  },
  {
    version: "2.230.2",
    date: "2026-07-23",
    title: "Type filter now lists only the types on the board",
    highlights: [
      {
        kind: "improvement",
        text: "The Type filter on the Timeline and Kanban boards now shows only the work-item types actually present on that board, instead of the org's entire type catalog — so a software project no longer sees construction/manufacturing/event types it never uses. (The Table view already worked this way.) An active type selection stays visible so you can always clear it.",
      },
    ],
  },
  {
    version: "2.230.1",
    date: "2026-07-23",
    title: "Sprint planning polish: correct card dates, member emails, empty-sprint pacing",
    highlights: [
      {
        kind: "fix",
        text: "Sprint/cycle cards showed dates one day early in western timezones — the start/end dates now render as the exact calendar days you entered.",
      },
      {
        kind: "improvement",
        text: "The start-sprint capacity list now shows each member's email under their name, so two people with the same display name are no longer indistinguishable.",
      },
      {
        kind: "fix",
        text: "The sprint-review Pacing tile now reads “—” for a sprint with no items, instead of a misleading “On track / 1× ideal.”",
      },
    ],
  },
  {
    version: "2.230.0",
    date: "2026-07-23",
    title: "Sprint planning: capacity-aware start + sprint review",
    highlights: [
      {
        kind: "feature",
        text: "Starting a sprint now opens a planning dialog first: set each member's capacity and availability, a sprint goal, and see committed scope vs. team capacity live with an over-commitment warning — instead of the sprint jumping straight to active.",
      },
      {
        kind: "feature",
        text: "Completing a sprint now runs a review step — efficiency, burn rate, pacing against the ideal burndown, and items/points completed — before the finalize/rehome step.",
      },
      {
        kind: "improvement",
        text: "A planned sprint can be edited or deleted freely before it starts, with regression tests locking the behavior in.",
      },
    ],
  },
  {
    version: "2.229.0",
    date: "2026-07-23",
    title: "Gantt: Dependencies view keeps epic/feature/story nesting",
    highlights: [
      {
        kind: "improvement",
        text: "Turning on the Dependencies lens on the timeline now keeps the same epic → feature → story nesting as the normal view, instead of flattening every linked item into a single list. Parents in the chain are shown for structure, and collapse works the same as when the lens is off.",
      },
    ],
  },
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
        text: "The Cosmo assistant now knows who it's talking to, so \"assign this to me\" just works, and it resolves projects by loose name — say \"Acme Corp\" and it maps to your ACME project.",
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
