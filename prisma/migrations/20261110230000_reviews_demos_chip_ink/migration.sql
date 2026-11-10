-- Data only: no schema change.
--
-- The default "Reviews & Demos" event category shipped with ink #0F766E on a
-- 45 212 191 tint. On the program calendar that pair measured 4.52:1 on a plain
-- day and 4.16:1 on today's tinted column, under the 4.5:1 WCAG AA needs for
-- 11px text. The default is now #115E59 (5.77:1 on today's column), but
-- categories are copied into an org's own rows the first time it opens the
-- calendar, and an import that invents a category copies a default's colours
-- too. Changing the default alone would leave every existing copy failing.
--
-- Matched on the colour PAIR, not the name: an imported category with a
-- different name carries the same pair and fails the same way, and a renamed
-- default still does. A row whose ink someone changed is left alone.
UPDATE "event_categories"
SET "text_color" = '#115E59', "updated_at" = NOW()
WHERE upper("text_color") = '#0F766E'
  AND "tint_rgb" = '45 212 191';
