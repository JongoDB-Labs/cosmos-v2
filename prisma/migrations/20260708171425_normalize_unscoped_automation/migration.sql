-- An autonomous-delivery config with no projectIds can't run; the new enable-gate
-- rejects that state, so a pre-existing {enabled:true} with no projectIds would trap
-- the settings form. Set it disabled (accurate — it was never actionable). Do NOT
-- touch autoRemediation: its legacy shape stores targetProjectId (normalized to
-- projectIds on read), so it is not "unscoped".
UPDATE "organizations"
SET settings = jsonb_set(settings, '{autonomousDelivery,enabled}', 'false'::jsonb)
WHERE settings->'autonomousDelivery'->>'enabled' = 'true'
  AND (
    settings->'autonomousDelivery'->'projectIds' IS NULL
    OR jsonb_typeof(settings->'autonomousDelivery'->'projectIds') <> 'array'
    OR jsonb_array_length(settings->'autonomousDelivery'->'projectIds') = 0
  );
