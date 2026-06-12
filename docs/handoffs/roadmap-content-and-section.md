# Handoff: Roadmap section + populate issue descriptions from the VITL roadmap

**Prod feedback FR** (title): "Description blocks in issues should reference technical roadmap v8.0 doc and latest COA 1 POAMs for source of truth." Description: "currently no actual descriptions in each issue. need to do a thorough review of VITL-BMA_Technical_Roadmap_v8.0 as well as latest COA 1 POAMs to populate each issue with relevant data points and background (e.g. we can't just say DP-XX. we need [the actual content])."

Read `docs/handoffs/README.md` first for shared context (deploy loop, test stack, Playwright `localhost` rule, mark-done SQL).

## Source material (in the user's home dir `~/`)
- **`VITL-BMA_Technical_Roadmap_v8.0_jon_2026-05-30.docx`** — the authoritative roadmap. Extract text with `unzip -p "<file>" word/document.xml | sed -e 's/<w:p[ >]/\n/g' -e 's/<[^>]*>//g' | sed '/^$/d'`. Structure: 25 sections incl. SP-0…SP-7 + SP-BG-1/2 sub-phases, 3 LOEs, **risk register R-01…R-40 (§19)**, **decision register DP-01…DP-32 + DP-AKS-1 (§20)**, info-required/who-to-talk-to (§21), task org (§22), Gantt/milestones (§23). COA #1 selected (InfoMarines RMF partner, VITL-BMA v3 on AKS IL4/5/6 in MCEN; ATO target 1 Oct 2026; Criterion 1 = 1 Nov 2026, Criterion 2 = 1 Mar 2027).
- **`VITL-BMA_Backlog_Import_v2.0_jon_2026-06-04.csv`** + **`Jira 2026-06-04T20_39_05-0500.csv`** — the actual backlog items (the issues whose descriptions need populating). The VITL CSV columns: IssueType, ExternalID, Summary, EpicName, EpicLink, ParentID, Predecessor, LOE, Sprint, Owner, Assignee, OrgOwner, Priority, Status, StoryPoints, StartDate, DueDate, Labels, Source, Description. "COA 1 POAMs" = the POA&M family referenced in the roadmap (LOE 1/2/3); ask the user for the POAM source file if it's not one of these CSVs.

## Two parts
### Part A — a dedicated "Roadmap" section/feature in COSMOS
The user said this "will likely need its own dedicated section." Build a project- (or org-) scoped Roadmap surface that renders the roadmap as structured, navigable reference data — so an issue's description can LINK to the relevant roadmap node (phase / LOE / risk / decision) as source-of-truth instead of restating it. Suggested design:
- New nav entry/page (gate behind a feature flag or project setting). Model the IA on the existing project sub-pages (`src/app/(dashboard)/[orgSlug]/projects/[projectKey]/...` — e.g. milestones/okrs). Reuse `PageShell`.
- Data model: a `RoadmapNode` (or reuse `Milestone`/`Objective` if a fit) keyed by the roadmap's own ids (SP-x, LOE-x, R-xx, DP-xx) with title/body/section. Seed it from the docx (a one-time importer or a seed script under `prisma/seed/`). Additive migration only (see how `meeting_type_options` / `crm_contact_fields` migrations were done — additive nullable, no GRANT needed).
- Render: a left-rail of sections (1–25) → node list → node detail. Make each node addressable by a stable anchor so issues can deep-link.

### Part B — populate issue descriptions
- For each backlog issue (matched by ExternalID/Summary to the roadmap's phases/LOEs/risks/decisions), write a real description: the actual background + the relevant roadmap data points, with a link to the Part-A roadmap node — NOT just "DP-XX". The CSV `Description` column + the roadmap text are your inputs.
- Decide the mechanism with the user: (a) a one-time backfill script that updates `work_items.description` for the imported VITL project, or (b) surface a "Reference roadmap" picker in the work-item detail that inserts the node's content/link. (a) is the literal ask; (b) is reusable. Recommend doing both: the picker for ongoing use + a backfill for the existing import.

## Acceptance
- A Roadmap section exists, navigable, rendering the v8.0 structure (phases/LOEs/risks/decisions) as source-of-truth, deep-linkable.
- Imported VITL issues have real descriptions citing the roadmap (with links), not bare ids.
- Verified via Playwright (`localhost`): the Roadmap page renders nodes; an issue's description shows populated content + a working roadmap link.
- Deployed (migrate-then-app if schema), prod healthy, feedback item marked DONE, `OVERNIGHT_BUILD_LOG.md` updated.

## Notes / cautions
- This is CUI-adjacent program content. Keep it inside the tenant; do NOT send roadmap text to any external service. The app's CUI-blind chokepoint must be respected (see the agent's classifier model).
- Confirm with the user which project the VITL backlog was imported into (the importer is `src/.../projects/[projectKey]/import`), and where the "latest COA 1 POAMs" live, before backfilling.
