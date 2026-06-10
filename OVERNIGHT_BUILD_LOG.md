# Overnight build log — 2026-06-10

Autonomous overnight build. Each entry = one deployed-to-prod change. Newest at the bottom of each session. All commits are local until you push.

## Already shipped this session (2.57.5 → 2.58.8, before the overnight run)
- **2.57.5** fix: SCRUM board Base UI #31 crash (bare `DropdownMenuLabel`) + sprint scoping on mount
- **2.57.6** feat: work-item delete + duplicate on the detail sheet
- **2.57.7** feat: live board/issues updates via SSE
- **2.57.8** feat: filter issues by created/updated date range
- **2.57.9** feat: story/task hierarchy (parent picker + add sub-item)
- **2.58.0** feat: per-user Claude subscription for the agent (preferred over org)
- **2.58.1** fix: project feature-toggle 400 on legacy flag
- **2.58.2** feat: project-manager board-create gate + board delete UI
- **2.58.3** feat: bulk-edit on the org-wide Issues view
- **2.58.4** feat: per-project classification banner + Applied-By name
- **2.58.5** feat: "+ New issue" on table/backlog/timeline/calendar/RAID
- **2.58.6** feat: quick Duplicate/Delete in the issue row menus
- **2.58.7** feat: comment edit/delete + invitation revoke/resend (the 2 real CRUD gaps)
- **2.58.8** feat: feedback (bug/FR) analytics tab

## Overnight run (continuous)
- **2.59.0** feat: feedback attachments + telemetry (Slice B). Screenshot/PDF upload on bug/FR submit (8 MB, magic-byte sniffed, auth-served), auto-structured telemetry on bug reports (route/UA/stack + repeat-sighting history with hit counts), attachments shown on portal items. New `FeedbackAttachment` model + `telemetry` column (migration applied). _Completes the feedback FR end-to-end (analytics tab in 2.58.8 + this)._
