-- Widen idx_ai_summaries_digest_unique so a stale digest row and its live
-- replacement can coexist for the same (org, dataset, week). Without this,
-- getCachedDigest excluding stale rows (this same change) means
-- markStale followed by a regenerated digest hits a unique violation on
-- insert, since the old stale row still occupies that slot.

DROP INDEX IF EXISTS "idx_ai_summaries_digest_unique";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_ai_summaries_digest_unique"
  ON "ai_summaries" ("org_id", "dataset_id", "audience", "week_start")
  WHERE "audience" = 'digest-weekly' AND "stale_at" IS NULL;
