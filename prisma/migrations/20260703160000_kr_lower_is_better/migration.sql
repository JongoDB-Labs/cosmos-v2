-- OKR refinement: key results where the metric improves as it goes DOWN (latency,
-- cost, defects). Progress then measures start→target descending. Additive.
ALTER TABLE "key_results" ADD COLUMN "lower_is_better" BOOLEAN NOT NULL DEFAULT false;
