-- FOUO ("For Official Use Only") was RETIRED in favor of CUI ("Controlled
-- Unclassified Information") per DoDI 5200.48. Migrate any legacy data so the
-- deprecated marking no longer appears in the UI. The FOUO enum value is KEPT for
-- back-compat (the egress marking detector still catches the "FOUO" token), it is
-- simply no longer assignable in the picker and renders as "CUI".
-- Idempotent: re-running is a no-op once no FOUO rows remain.
UPDATE "data_classifications" SET level = 'CUI' WHERE level = 'FOUO';
UPDATE "documents" SET classification_level = 'CUI' WHERE classification_level = 'FOUO';
