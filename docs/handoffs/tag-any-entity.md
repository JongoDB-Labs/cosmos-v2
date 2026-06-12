# Handoff: @-tag any entity (people, issues, projects, docs, …)

**Prod feedback FR** "ability to tag people, issues, and other classes of info throughout the app via chat, notes, comments, assistant, etc.": "should be able to place @ to then tag whatever exists in the app for any user input/communication (define the schema if that hasn't happened already, as it should also inform cmd/ctrl+k quick actions)."

Read `docs/handoffs/README.md` first for shared context.

## Current state
- **People @-mentions EXIST:** `src/components/chat/mention-typeahead.tsx` (`MentionPicker` + `useOrgMembers`) drives @-person mentions in chat/comments/notes; mentions render as names (the uuid→slug/name work is done). The Notes editor is Lexical WYSIWYG with mentions; chat/comments use the same picker.
- **The gap:** @ only resolves PEOPLE. The FR wants @ to resolve ANY entity class — work items (#KEY-123 / "issue X"), projects, boards, documents/notes, meetings, etc. — with a typeahead that searches across types, a canonical reference token stored in the content, and rendering as a clickable chip that deep-links.

## Build
1. **Define the reference schema** (the FR explicitly asks). A mention/reference token needs: `{ type: 'user'|'workItem'|'project'|'note'|'meeting'|'board'|... , id, label }`. Decide storage: the markdown/Lexical content already encodes people-mentions some way — extend that token format to carry `type`. Keep it stable so the same token renders everywhere and powers backlinks.
2. **Unified search backend:** there is a global search already (cmd+K, `src/components/.../command-palette` + the search API used by it, and `/api/v1/orgs/[orgId]/search`-style endpoints). Reuse/extend it as the @-typeahead source so @ and ⌘K share one entity index (the FR wants this — "should also inform cmd/ctrl+k quick actions"). Group results by type.
3. **Typeahead UI:** generalize `mention-typeahead.tsx` from members-only to multi-type (type-grouped results, an icon per type). Wire it into: chat composer, comments, the Lexical notes editor, the assistant input. Each surface inserts the canonical token.
4. **Render:** a mention chip per type (e.g. `@Alice`, `#TEST-42`, `▸ Project X`) that links to the entity. Reuse existing chip rendering; add per-type routing.
5. **(Optional, high value) backlinks:** persist references so an entity can show "mentioned in …". Needs a `Reference`/`Mention` table (additive migration). Scope with the user — the core FR is the @-typeahead + render; backlinks are a stretch.

## Acceptance
- Typing `@` in chat / a comment / a note / the assistant shows a type-grouped typeahead (people + issues + projects + …); selecting inserts a token that renders as a clickable chip deep-linking to the entity.
- ⌘K and @ share the same entity search source.
- Verified via Playwright (`localhost`) on at least chat + notes + comments.
- Deployed, prod healthy, feedback item DONE, log updated.

## Watch out
- Big surface area (chat, comments, Lexical notes, assistant) — do one surface fully, verify, then replicate. Keep the token format backward-compatible with existing people-mentions so old content still renders. The assistant input feeds the CUI-blind chokepoint — tagged entity ids are fine, but don't expand a tag into CUI content before the egress gate.
