-- Idempotent: the journal backfill that registers this migration may run against
-- a database where digest objects were already created out-of-band (drizzle-kit
-- push during dev). Guards make a re-apply a no-op instead of an error.
DO $$ BEGIN
  CREATE TYPE "digest_valence" AS ENUM ('positive', 'concerning', 'watching', 'neutral');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "digest_history" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "dataset_id" integer REFERENCES "datasets"("id") ON DELETE SET NULL,
  "summary_id" integer REFERENCES "ai_summaries"("id") ON DELETE SET NULL,
  "week_start" timestamp with time zone NOT NULL,
  "subject_line" text NOT NULL,
  "state_sentence" text NOT NULL,
  "valence" "digest_valence" NOT NULL,
  "key_stats" jsonb NOT NULL,
  "milestones" jsonb DEFAULT '[]' NOT NULL,
  "sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_digest_history_org_week" ON "digest_history" ("org_id", "week_start");
--> statement-breakpoint
ALTER TABLE "digest_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "digest_history_tenant_isolation" ON "digest_history";
--> statement-breakpoint
CREATE POLICY "digest_history_tenant_isolation" ON "digest_history"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint
DROP POLICY IF EXISTS "digest_history_admin_bypass" ON "digest_history";
--> statement-breakpoint
CREATE POLICY "digest_history_admin_bypass" ON "digest_history"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
