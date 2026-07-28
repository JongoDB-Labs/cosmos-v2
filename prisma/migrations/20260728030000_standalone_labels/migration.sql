-- Promote labels from bare strings to rows.
--
-- Until now a "label" was just an entry in work_items.tags. That meant an org
-- had no list of the labels it actually uses, nothing could be renamed or
-- recoloured across projects, and "Security" / "security" / "SECURITY" were
-- three separate values in every filter dropdown.
--
-- work_items.tags is deliberately KEPT and stays populated. The RAID board
-- categorises entirely by tag, and the AI tools, ingest and feedback paths all
-- read the array — mirroring instead of cutting over means none of them had to
-- change to land this. Application code keeps both sides in step through a
-- single helper.

CREATE TABLE "labels" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "org_id"     UUID         NOT NULL,
    "name"       TEXT         NOT NULL,
    "color"      TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "work_item_labels" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "org_id"       UUID         NOT NULL,
    "work_item_id" UUID         NOT NULL,
    "label_id"     UUID         NOT NULL,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_labels_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "labels_org_id_idx" ON "labels"("org_id");

-- Case-insensitive uniqueness is the point of the migration: it is what makes
-- "Security" and "security" converge instead of coexisting. Enforced by a
-- functional index because Prisma cannot express one in the schema.
CREATE UNIQUE INDEX "labels_org_id_lower_name_key" ON "labels"("org_id", lower("name"));

CREATE UNIQUE INDEX "work_item_labels_work_item_id_label_id_key" ON "work_item_labels"("work_item_id", "label_id");
CREATE INDEX "work_item_labels_org_id_label_id_idx" ON "work_item_labels"("org_id", "label_id");

ALTER TABLE "labels" ADD CONSTRAINT "labels_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_item_labels" ADD CONSTRAINT "work_item_labels_work_item_id_fkey"
    FOREIGN KEY ("work_item_id") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_item_labels" ADD CONSTRAINT "work_item_labels_label_id_fkey"
    FOREIGN KEY ("label_id") REFERENCES "labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill 1: one label row per distinct (org, case-folded tag).
--
-- Each fold needs ONE surviving spelling, and which one users see matters — so
-- the most-used spelling wins ("Security" over a single stray "SECURITY").
-- Ties break on the C collation rather than the database's, which would
-- otherwise pick a different winner on a differently-configured instance.
WITH spellings AS (
    SELECT w."org_id", btrim(t.tag) AS tag, count(*) AS uses
    FROM "work_items" w
    CROSS JOIN LATERAL unnest(w."tags") AS t(tag)
    WHERE btrim(t.tag) <> ''
    GROUP BY w."org_id", btrim(t.tag)
)
INSERT INTO "labels" ("org_id", "name")
SELECT DISTINCT ON ("org_id", lower(tag)) "org_id", tag
FROM spellings
ORDER BY "org_id", lower(tag), uses DESC, tag COLLATE "C";

-- Backfill 2: attach each item to the labels its tags name.
--
-- The join folds AND trims to match how the names above were built — a tag
-- stored as " Security " has to find the label named "Security", or the item
-- would silently come out of the migration with fewer labels than it had tags.
-- ON CONFLICT absorbs an item that carried two spellings of one label, which
-- would otherwise collide on the unique index.
INSERT INTO "work_item_labels" ("org_id", "work_item_id", "label_id")
SELECT DISTINCT w."org_id", w."id", l."id"
FROM "work_items" w
CROSS JOIN LATERAL unnest(w."tags") AS t(tag)
JOIN "labels" l
  ON l."org_id" = w."org_id"
 AND lower(l."name") = lower(btrim(t.tag))
WHERE btrim(t.tag) <> ''
ON CONFLICT ("work_item_id", "label_id") DO NOTHING;
