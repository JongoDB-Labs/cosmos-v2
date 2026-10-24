-- Feedback discussion, Phase 2 backfill. Data only: puts existing rows in the
-- shape the Phase 2 code writes from now on.

-- 1) Everyone who already cares about an item follows it: its author, then
--    every voter. The first reason wins; nobody has opted out yet.
INSERT INTO "feedback_subscriptions" ("org_id", "feedback_item_id", "user_id", "reason")
SELECT fi."org_id", fi."id", fi."author_id", 'author'
FROM "feedback_items" fi
ON CONFLICT ("feedback_item_id", "user_id") DO NOTHING;

INSERT INTO "feedback_subscriptions" ("org_id", "feedback_item_id", "user_id", "reason")
SELECT fi."org_id", fv."feedback_item_id", fv."user_id", 'voter'
FROM "feedback_votes" fv
JOIN "feedback_items" fi ON fi."id" = fv."feedback_item_id"
ON CONFLICT ("feedback_item_id", "user_id") DO NOTHING;

-- 2) Intake recorded a duplicate as DECLINED + triage.duplicate.targetFeedbackId.
--    Make each a real merge, as intake now writes it, but only:
--     - while it is still DECLINED (staff may have reopened a wrong call);
--     - into the FINAL survivor: A -> B where B is itself such a duplicate of C
--       merges A into C, so no merged item points at a merged one;
--     - when the chain ends at a live, unmerged item in the same org. A chain
--       that loops (A -> B -> A) or ends nowhere is left as it is.
CREATE TEMP TABLE "_fb_merge_plan" AS
WITH RECURSIVE cand AS (
  SELECT d."id", d."org_id", d."created_at",
         (d."triage"->'duplicate'->>'targetFeedbackId')::uuid AS target
  FROM "feedback_items" d
  WHERE d."status" = 'DECLINED'
    AND d."merged_into_id" IS NULL
    AND d."triage" ? 'duplicate'
    AND (d."triage"->'duplicate'->>'targetFeedbackId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
walk AS (
  SELECT c."id" AS start, c."org_id", c.target AS cur, ARRAY[c."id"] AS path, 1 AS depth
  FROM cand c
  UNION ALL
  SELECT w.start, w."org_id", c2.target, w.path || c2."id", w.depth + 1
  FROM walk w
  JOIN cand c2 ON c2."id" = w.cur AND c2."org_id" = w."org_id"
  WHERE NOT (c2."id" = ANY (w.path)) AND w.depth < 50
)
SELECT w.start AS duplicate_id, w."org_id", s."id" AS survivor_id, c."created_at" AS dup_created_at
FROM walk w
JOIN cand c ON c."id" = w.start
JOIN "feedback_items" s
  ON s."id" = w.cur
 AND s."org_id" = w."org_id"
 AND s."merged_into_id" IS NULL
 AND s."status" <> 'MERGED'
WHERE NOT EXISTS (SELECT 1 FROM cand t WHERE t."id" = w.cur)
  AND NOT (w.cur = ANY (w.path));

-- Followers a merge adds to its survivor: the duplicate's followers the
-- survivor lacked. One (survivor, person) pair belongs to ONE merge, the
-- earliest duplicate, so undoing another merge never takes it away.
CREATE TEMP TABLE "_fb_merge_followers" AS
SELECT DISTINCT ON (p.survivor_id, sub."user_id")
       p.duplicate_id, p.survivor_id, p."org_id", sub."user_id"
FROM "_fb_merge_plan" p
JOIN "feedback_subscriptions" sub
  ON sub."feedback_item_id" = p.duplicate_id AND sub."unsubscribed_at" IS NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "feedback_subscriptions" have
  WHERE have."feedback_item_id" = p.survivor_id AND have."user_id" = sub."user_id"
)
ORDER BY p.survivor_id, sub."user_id", p.dup_created_at, p.duplicate_id;

-- Intake already moved the votes and dropped the duplicate's own rows, so no
-- vote moves are recorded; an undo restores status and followers.
INSERT INTO "feedback_merges"
  ("org_id", "duplicate_id", "survivor_id", "previous_status", "source", "merged_by_id", "added_subscriber_ids")
SELECT p."org_id", p.duplicate_id, p.survivor_id, 'DECLINED', 'intake', NULL,
       COALESCE((SELECT array_agg(f."user_id" ORDER BY f."user_id")
                 FROM "_fb_merge_followers" f WHERE f.duplicate_id = p.duplicate_id), '{}')
FROM "_fb_merge_plan" p;

INSERT INTO "feedback_subscriptions" ("org_id", "feedback_item_id", "user_id", "reason")
SELECT f."org_id", f.survivor_id, f."user_id", 'merged'
FROM "_fb_merge_followers" f
ON CONFLICT ("feedback_item_id", "user_id") DO NOTHING;

UPDATE "feedback_items" d
SET "status" = 'MERGED', "merged_into_id" = p.survivor_id, "vote_count" = 0
FROM "_fb_merge_plan" p
WHERE d."id" = p.duplicate_id;

DROP TABLE "_fb_merge_followers";
DROP TABLE "_fb_merge_plan";
