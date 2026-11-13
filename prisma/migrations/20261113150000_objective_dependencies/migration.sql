-- Objective dependencies: one objective waiting on another. A new table only;
-- nothing existing changes. Both ends cascade with their objective, and the
-- row cascades with its org. Same-org and no-cycle rules are enforced on write
-- (lib/okr/dependencies.server.ts); the database refuses a self-dependency.

-- CreateTable
CREATE TABLE "objective_dependencies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "depends_on_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "objective_dependencies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "objective_dependencies_not_self" CHECK ("objective_id" <> "depends_on_id")
);

-- CreateIndex
CREATE INDEX "objective_dependencies_depends_on_id_idx" ON "objective_dependencies"("depends_on_id");

-- CreateIndex
CREATE INDEX "objective_dependencies_org_id_idx" ON "objective_dependencies"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "objective_dependencies_objective_id_depends_on_id_key" ON "objective_dependencies"("objective_id", "depends_on_id");

-- AddForeignKey
ALTER TABLE "objective_dependencies" ADD CONSTRAINT "objective_dependencies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_dependencies" ADD CONSTRAINT "objective_dependencies_objective_id_fkey" FOREIGN KEY ("objective_id") REFERENCES "objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objective_dependencies" ADD CONSTRAINT "objective_dependencies_depends_on_id_fkey" FOREIGN KEY ("depends_on_id") REFERENCES "objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;
