-- Backfill human-readable slugs for boards created before slugs existed.
-- Data-only: the `slug` column + unique([project_id, slug]) already exist. Every
-- board's slug is NULL at this point (nothing ever set it), so there are no
-- pre-existing slugs to collide with. Mirrors the app's slugify(): lowercase,
-- non-alphanumeric runs -> "-", trim leading/trailing "-", cap at 50 chars,
-- empty -> "board"; per (project, base) duplicates get a -2, -3, … suffix.
WITH slugged AS (
  SELECT
    id,
    project_id,
    sort_order,
    created_at,
    COALESCE(
      NULLIF(
        left(
          regexp_replace(
            regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'),
            '(^-+|-+$)', '', 'g'
          ),
          50
        ),
        ''
      ),
      'board'
    ) AS base
  FROM boards
  WHERE slug IS NULL
),
numbered AS (
  SELECT
    id,
    base,
    row_number() OVER (
      PARTITION BY project_id, base
      ORDER BY sort_order, created_at, id
    ) AS rn
  FROM slugged
)
UPDATE boards b
SET slug = CASE WHEN n.rn = 1 THEN n.base ELSE n.base || '-' || n.rn END
FROM numbered n
WHERE b.id = n.id;
