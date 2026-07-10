-- Data-only backfill: feedback items delivered as work items were stamped PLANNED
-- at delivery and never updated again, so feedback whose work item already moved
-- (in-progress / review / done) shows a stale status to its reporter. Going
-- forward the app + Foreman sync statuses on every column move
-- (src/lib/feedback/status-sync.ts); this brings the existing rows current.
--
-- Only PLANNED rows are touched: OPEN (undelivered), DONE, and DECLINED (a human
-- decision) are never modified. Column matching mirrors feedbackStatusForColumn.
UPDATE feedback_items f
SET status = CASE
      WHEN lower(w.column_key) LIKE '%done%'
        OR lower(w.column_key) LIKE '%completed%'
        OR lower(w.column_key) LIKE '%closed%'
        OR lower(w.column_key) LIKE '%shipped%'
        THEN 'DONE'::"FeedbackStatus"
      WHEN lower(w.column_key) LIKE '%progress%'
        OR lower(w.column_key) LIKE '%doing%'
        OR lower(w.column_key) LIKE '%review%'
        OR lower(w.column_key) LIKE '%testing%'
        OR lower(w.column_key) LIKE '%building%'
        THEN 'IN_PROGRESS'::"FeedbackStatus"
      ELSE f.status
    END,
    updated_at = now()
FROM work_items w
WHERE w.id = f.work_item_id
  AND f.status = 'PLANNED'
  AND (
        lower(w.column_key) LIKE '%done%' OR lower(w.column_key) LIKE '%completed%'
     OR lower(w.column_key) LIKE '%closed%' OR lower(w.column_key) LIKE '%shipped%'
     OR lower(w.column_key) LIKE '%progress%' OR lower(w.column_key) LIKE '%doing%'
     OR lower(w.column_key) LIKE '%review%' OR lower(w.column_key) LIKE '%testing%'
     OR lower(w.column_key) LIKE '%building%'
  );
