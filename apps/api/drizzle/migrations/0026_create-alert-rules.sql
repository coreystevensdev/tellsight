-- Story 10.1: alert_rules table. Owner-defined thresholds that trigger a
-- send between weekly digests (Story 10.2's evaluator reads this table;
-- nothing here enqueues anything yet).
--
-- deleted_at is a soft-delete, the first one in this schema: Story 10.2's
-- alert_rule_fires ledger keeps a foreign key into this table, and a hard
-- delete would orphan historical fires. created_by_user_id is SET NULL
-- (not CASCADE like org_invites.created_by) because a rule is an org asset
-- that should keep firing after its creator leaves the org.
DO $$ BEGIN
  CREATE TYPE "alert_rule_kind" AS ENUM (
    'runway_runs_short',
    'margin_drops',
    'cash_burn_spikes',
    'breakeven_gap_widens',
    'anomaly_fires'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_rules" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "created_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "kind" "alert_rule_kind" NOT NULL,
  "threshold" jsonb NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "mute_until" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "alert_rules_mute_until_future" CHECK ("mute_until" IS NULL OR "mute_until" > now())
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_alert_rules_org_id" ON "alert_rules" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_alert_rules_org_enabled"
  ON "alert_rules" ("org_id", "enabled")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "alert_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "alert_rules_tenant_isolation" ON "alert_rules";
--> statement-breakpoint
CREATE POLICY "alert_rules_tenant_isolation" ON "alert_rules"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint
DROP POLICY IF EXISTS "alert_rules_admin_bypass" ON "alert_rules";
--> statement-breakpoint
CREATE POLICY "alert_rules_admin_bypass" ON "alert_rules"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
