-- Foreman observability: daemon pulse singleton + decision-event feed.
CREATE TABLE "foreman_state" (
    "id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "last_pass_at" TIMESTAMP(3) NOT NULL,
    "daemon_version" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "worker_target" INTEGER NOT NULL,
    "slots_busy" INTEGER NOT NULL,
    "queue_depth" INTEGER NOT NULL,
    "in_flight" JSONB NOT NULL,
    "breaker" JSONB NOT NULL,
    "stop_file_seen" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "foreman_state_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "foreman_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "org_id" UUID,
    "work_item_id" UUID,
    "ticket_key" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "data" JSONB,
    CONSTRAINT "foreman_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "foreman_events_org_id_ts_idx" ON "foreman_events"("org_id", "ts" DESC);
