-- Story 10.3: extend ai_summaries for audience='alert'. Alert summaries are
-- one-shot per fire event, not week-pinned like digest, so cache identity is
-- (org, dataset, fire_id) instead of (org, dataset, week_start).

ALTER TABLE "ai_summaries"
  ADD COLUMN IF NOT EXISTS "fire_id" integer REFERENCES "alert_rule_fires"("id") ON DELETE CASCADE;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "ai_summaries" DROP CONSTRAINT IF EXISTS "ai_summaries_audience_check";
  ALTER TABLE "ai_summaries"
    ADD CONSTRAINT "ai_summaries_audience_check"
    CHECK ("audience" IN ('dashboard', 'digest-weekly', 'share', 'alert'));
END $$;
--> statement-breakpoint

-- Partial unique, same pattern as idx_ai_summaries_digest_unique: one alert
-- summary per (org, dataset, fire), doesn't touch dashboard/digest rows.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_ai_summaries_alert_unique"
  ON "ai_summaries" ("org_id", "dataset_id", "audience", "fire_id")
  WHERE "audience" = 'alert';
