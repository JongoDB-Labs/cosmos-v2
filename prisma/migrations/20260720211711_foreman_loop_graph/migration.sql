-- CreateTable
CREATE TABLE "foreman_loop_transition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "loop_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "iteration" INTEGER NOT NULL,
    "from_phase" TEXT NOT NULL,
    "to_phase" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "termination_signal" TEXT,
    "invariant_results" JSONB NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "state_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "foreman_loop_transition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "foreman_loop_state" (
    "loop_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "foreman_loop_state_pkey" PRIMARY KEY ("loop_id")
);

-- CreateTable
CREATE TABLE "foreman_loop_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID,
    "mode" TEXT NOT NULL DEFAULT 'off',
    "wall_clock_min" INTEGER NOT NULL DEFAULT 90,
    "cost_usd_ceiling" DOUBLE PRECISION,
    "stall_rounds" INTEGER NOT NULL DEFAULT 3,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "foreman_loop_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "foreman_loop_transition_loop_id_iteration_key" ON "foreman_loop_transition"("loop_id", "iteration");

-- CreateIndex
CREATE INDEX "foreman_loop_transition_org_id_created_at_idx" ON "foreman_loop_transition"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "foreman_loop_transition_loop_id_idx" ON "foreman_loop_transition"("loop_id");

-- CreateIndex
CREATE INDEX "foreman_loop_state_org_id_status_idx" ON "foreman_loop_state"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "foreman_loop_settings_org_id_key" ON "foreman_loop_settings"("org_id");
