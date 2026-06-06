-- Synthesize url for legacy notifications using the same mapping the
-- dropdown previously used. After this runs, notification-dropdown.tsx
-- can drop the entityRoutes fallback (and does, in this same task).

UPDATE notifications
SET url = CASE ref_type
  WHEN 'work_item' THEN '/projects'
  WHEN 'objective' THEN '/projects'
  WHEN 'contact'   THEN '/crm'
  WHEN 'note'      THEN '/notes'
  ELSE '/'
END
WHERE url IS NULL;
