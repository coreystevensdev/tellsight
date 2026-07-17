-- Story 10.2: alert_rule_fires ledger. Append-only record of every fire
-- decision the evaluator makes; backs state-transition dedup (compare band
-- against a rule's most recent fire) and the 3-per-7-day org quota.
--
-- org_id is denormalized off alert_rules rather than joined at query time:
-- the quota check counts fires per org, and RLS needs org_id on the row
-- itself, not one join away.
CREATE TABLE IF NOT EXISTS "alert_rule_fires" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "rule_id" integer NOT NULL REFERENCES "alert_rules"("id") ON DELETE CASCADE,
  "rule_kind" "alert_rule_kind" NOT NULL,
  "trigger" text NOT NULL,
  "threshold_value" jsonb NOT NULL,
  "current_value" double precision NOT NULL,
  "band" integer NOT NULL,
  "fired_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_alert_rule_fires_rule_id" ON "alert_rule_fires" ("rule_id", "fired_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_alert_rule_fires_org_id" ON "alert_rule_fires" ("org_id", "fired_at" DESC);
--> statement-breakpoint
ALTER TABLE "alert_rule_fires" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "alert_rule_fires_tenant_isolation" ON "alert_rule_fires";
--> statement-breakpoint
CREATE POLICY "alert_rule_fires_tenant_isolation" ON "alert_rule_fires"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint
DROP POLICY IF EXISTS "alert_rule_fires_admin_bypass" ON "alert_rule_fires";
--> statement-breakpoint
CREATE POLICY "alert_rule_fires_admin_bypass" ON "alert_rule_fires"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
