-- Cutover write-freeze flag table (design spec §9.4 — per-tenant freeze → migrate → verify
-- → flip). A row here marks an org as write-frozen during its migration window: the request
-- proxy (src/proxy.ts) returns HTTP 405 on mutating verbs for that org while reads pass.
--
-- Keyed by BOTH org_slug (dashboard URLs /<slug>/…) and org_id (API URLs
-- /api/v1/orgs/<uuid>/…) so the proxy can match whichever identifier the URL carries.
--
-- OPERATIONAL state, NOT tenant data: intentionally NOT FK'd to organizations (survives
-- independently of the migration) and EXCLUDED from the cutover model graph
-- (scripts/cutover/lib/model-graph.ts) so it is never exported/imported as a tenant's data.
--
-- cosmos_app gets full DML automatically via ALTER DEFAULT PRIVILEGES FOR ROLE cosmos
-- (set in 20260606050000_audit_immutability) — the proxy reads it; the freeze/unfreeze
-- ops helpers write it. No extra GRANT needed.

CREATE TABLE "frozen_orgs" (
    "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"    UUID NOT NULL,
    "org_slug"  TEXT NOT NULL,
    "reason"    TEXT NOT NULL DEFAULT '',
    "frozen_by" TEXT,
    "frozen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "frozen_orgs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "frozen_orgs_org_id_key" ON "frozen_orgs"("org_id");
CREATE UNIQUE INDEX "frozen_orgs_org_slug_key" ON "frozen_orgs"("org_slug");
CREATE INDEX "frozen_orgs_org_slug_idx" ON "frozen_orgs"("org_slug");
