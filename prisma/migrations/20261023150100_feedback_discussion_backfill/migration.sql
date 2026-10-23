-- Feedback discussion backfill. A separate migration because the new
-- FeedbackStatus value 'MERGED' cannot be used in the transaction that adds it.

-- 1) Everyone who already cares about an item hears about it from now on:
--    its author, then every voter. The first reason wins.
INSERT INTO "feedback_subscriptions" ("org_id", "feedback_item_id", "user_id", "reason")
SELECT fi."org_id", fi."id", fi."author_id", 'author'
FROM "feedback_items" fi
ON CONFLICT ("feedback_item_id", "user_id") DO NOTHING;

INSERT INTO "feedback_subscriptions" ("org_id", "feedback_item_id", "user_id", "reason")
SELECT fi."org_id", fv."feedback_item_id", fv."user_id", 'voter'
FROM "feedback_votes" fv
JOIN "feedback_items" fi ON fi."id" = fv."feedback_item_id"
ON CONFLICT ("feedback_item_id", "user_id") DO NOTHING;

-- 2) Intake already merged duplicates, but recorded it only as DECLINED plus
--    triage.duplicate.targetFeedbackId. Make each a real merge: MERGED with a
--    pointer, and a FeedbackMerge row. Its votes already moved, so the moved_*
--    arrays stay empty and the merge cannot be undone, which is acceptable.
--    Only when the target still exists in the same org.
WITH dup AS (
  SELECT d."id" AS duplicate_id, d."org_id", t."id" AS survivor_id, d."status" AS previous_status
  FROM "feedback_items" d
  JOIN "feedback_items" t
    ON t."id"::text = d."triage"->'duplicate'->>'targetFeedbackId'
   AND t."org_id" = d."org_id"
   AND t."id" <> d."id"
  WHERE d."triage" ? 'duplicate'
    AND d."merged_into_id" IS NULL
)
INSERT INTO "feedback_merges" ("org_id", "duplicate_id", "survivor_id", "previous_status", "source", "merged_by_id")
SELECT dup."org_id", dup.duplicate_id, dup.survivor_id, dup.previous_status, 'intake', NULL
FROM dup;

UPDATE "feedback_items" d
SET "status" = 'MERGED', "merged_into_id" = m."survivor_id"
FROM "feedback_merges" m
WHERE m."duplicate_id" = d."id" AND m."source" = 'intake' AND d."merged_into_id" IS NULL;
