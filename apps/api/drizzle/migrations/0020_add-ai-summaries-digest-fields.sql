-- Extend ai_summaries to store digest-audience summaries alongside dashboard ones.
-- Existing rows backfill to audience='dashboard' via the column DEFAULT, no data
-- migration step needed. The partial unique index enforces one digest summary per
-- (org, dataset, week) without constraining the existing dashboard cache.

ALTER TABLE "ai_summaries"
  ADD COLUMN IF NOT EXISTS "audience" text NOT NULL DEFAULT 'dashboard';
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "ai_summaries"
    ADD CONSTRAINT "ai_summaries_audience_check"
    CHECK ("audience" IN ('dashboard', 'digest-weekly', 'share'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

ALTER TABLE "ai_summaries"
  ADD COLUMN IF NOT EXISTS "week_start" timestamp with time zone;
--> statement-breakpoint

-- Partial unique: enforces one digest row per (org, dataset, week) but leaves
-- the dashboard cache, which already allows fresh + stale rows per dataset,
-- untouched. Manual SQL because drizzle-kit 0.45.x doesn't reliably emit the
-- WHERE clause; pattern from 0013_fix-ai-summaries-rls-policy.sql.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_ai_summaries_digest_unique"
  ON "ai_summaries" ("org_id", "dataset_id", "audience", "week_start")
  WHERE "audience" = 'digest-weekly';
