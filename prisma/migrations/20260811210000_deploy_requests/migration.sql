-- Operator-requested deploys.
--
-- The app cannot deploy itself: its container has no docker socket and no host
-- mount. A row here is an INTENT; a host-side runner executes the deploy script
-- and writes the outcome back. This table is also the audit record for "who
-- deployed production, when" — AuditLog is org-scoped and a deploy is not.

CREATE TYPE "deploy_request_status" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED');

CREATE TABLE "deploy_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" TEXT NOT NULL,
    "status" "deploy_request_status" NOT NULL DEFAULT 'PENDING',
    "requested_by_id" UUID,
    "requested_by_email" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "claimed_by" TEXT,
    "heartbeat_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "exit_code" INTEGER,
    "log" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "deploy_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deploy_requests_status_requested_at_idx" ON "deploy_requests"("status", "requested_at");

-- SINGLE-FLIGHT, ENFORCED BY THE DATABASE.
--
-- "two concurrent runs against one host" is the failure mode this whole feature
-- has to avoid. An application-level "is one already active?" check cannot do
-- it: two requests can both read "none active" before either writes. A partial
-- unique index on a constant expression permits AT MOST ONE row in a
-- non-terminal state, so the second concurrent insert fails with a unique
-- violation no matter how the races line up. The API turns that into a 409.
CREATE UNIQUE INDEX "deploy_requests_one_active" ON "deploy_requests" ((TRUE))
    WHERE "status" IN ('PENDING', 'RUNNING');
