-- Per-user digest preferences. user_id PK enforces "one preference row per user
-- across all orgs" (Epic 9 decision C). Unsubscribe is global, not per-org.
-- Rows are upserted lazily on first digest attempt; no backfill needed because
-- every column has a sensible DEFAULT.

CREATE TABLE IF NOT EXISTS "digest_preferences" (
  "user_id" integer PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "cadence" text NOT NULL DEFAULT 'weekly',
  "timezone" text NOT NULL DEFAULT 'UTC',
  "last_sent_at" timestamp with time zone,
  "unsubscribed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "digest_preferences_cadence_check"
    CHECK ("cadence" IN ('weekly', 'monthly', 'off'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_digest_preferences_last_sent_at"
  ON "digest_preferences" ("last_sent_at");
--> statement-breakpoint

ALTER TABLE "digest_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- User-scoped policy: every read/mutation must match the authenticated user.
-- Worker code bypasses RLS via dbAdmin (platform operation, see queries/digestPreferences.ts).
DROP POLICY IF EXISTS "digest_preferences_owner" ON "digest_preferences";
--> statement-breakpoint
CREATE POLICY "digest_preferences_owner" ON "digest_preferences"
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true)::integer)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::integer);
--> statement-breakpoint

DROP POLICY IF EXISTS "digest_preferences_admin_bypass" ON "digest_preferences";
--> statement-breakpoint
CREATE POLICY "digest_preferences_admin_bypass" ON "digest_preferences"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
