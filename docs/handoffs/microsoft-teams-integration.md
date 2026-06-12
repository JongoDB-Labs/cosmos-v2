# Handoff: Microsoft Teams integration (end-to-end)

**Prod feedback FR** "microsoft teams integration work."

Read `docs/handoffs/README.md` first for shared context.

## Current state
- The integrations catalog (`src/lib/integrations/registry/catalog.generated.ts` + registry) lists ~120–150 providers with brand icons + `docsUrl`; **most are `coming_soon`** — only Google is `available` and fully wired. Microsoft Teams (and the broader M365/Graph) is a catalog entry, not a working connector.
- Connector plumbing exists: `src/lib/integrations/` has `credentials.ts` (sealed/encrypted), `nango.ts` (the COMMERCIAL-only Nango wrapper, gov-blocked by code), and the registry. The Meetings module already did Google Meet REST (spaces/artifacts/transcript) — a good reference for "wire a Microsoft Graph API directly" vs going through Nango.

## Decide first (with the user)
1. **Scope of "Teams integration":** chat-channel bridging? meeting creation (Teams online meetings via Graph)? presence? notifications/webhooks? The Meetings module pattern suggests **Teams online-meeting creation + join links via Microsoft Graph** is the highest-value parallel to the existing Google Meet work. Confirm.
2. **Auth path:** Microsoft Graph OAuth (per-org app registration, like the Google OAuth flow already built). Decide Nango (commercial-only, gov-blocked) vs a direct Graph OAuth + token vault (mirror the Google/Claude-subscription OAuth+vault pattern in `src/lib/integrations/credentials.ts` + the Settings → Integrations connect flow). For gov tenants, direct Graph (Azure Gov endpoints) — Nango is blocked there by design.
3. **Gov caveat:** Azure Commercial vs Azure Government Graph endpoints differ; the CUI-blind / gov-block model must hold (no CUI egress to commercial Teams). Confirm tenant target.

## Build (assuming Graph online-meetings, mirroring Google Meet)
1. OAuth connect flow in Settings → Integrations for Microsoft (scopes: `OnlineMeetings.ReadWrite`, `User.Read`, etc.), tokens sealed via the existing credential vault.
2. A Graph client wrapper (server-side only) under `src/lib/integrations/` (or `src/lib/meetings/`), token refresh handled like the Google one.
3. Wire into Meetings: create a Teams meeting → store join URL on the `SyncMeeting` (the model already has `videoProvider`/`meetingUrl` fields). Add "Microsoft Teams" to the meeting video-provider picker.
4. Honor the connector status in the catalog (flip Teams from `coming_soon` → `available` only once the flow actually completes).

## Acceptance
- A user connects Microsoft in Settings → Integrations (OAuth round-trip, tokens sealed).
- Creating a meeting with provider=Teams produces a real Graph online-meeting + join URL stored on the meeting.
- Verified end-to-end against a real (or sandboxed) tenant; gov-block/CUI model intact.
- Deployed, prod healthy, feedback item DONE, log updated.

## Watch out
- This needs a real Microsoft tenant + app registration (credentials the user must provide) — confirm availability before starting, or scope to the OAuth-connect + stubbed-call milestone. `googleapis`/`pdfkit` are externalized in `next.config.ts` (`serverExternalPackages`); if you add a CJS-heavy Graph SDK and the build complains about file-tracing, add it there too.
