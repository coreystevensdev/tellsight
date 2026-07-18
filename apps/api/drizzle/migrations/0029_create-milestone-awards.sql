-- Story 11.6: milestone_awards ledger. Fire-once record for the three
-- all-time-first milestones (first profitable month, first break-even,
-- first three-month profitable streak); the unique (org_id, kind) index is
-- the actual fire-once guarantee, detectFirstTimeMilestones only decides
-- what fired, this table enforces it never fires twice.
--
-- org_id is denormalized (not joined via dataset_id) for the same reason as
-- alert_rule_fires: RLS needs org_id on the row itself.
CREATE TABLE IF NOT EXISTS "milestone_awards" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "dataset_id" integer REFERENCES "datasets"("id") ON DELETE SET NULL,
  "awarded_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_milestone_awards_org_kind" ON "milestone_awards" ("org_id", "kind");
--> statement-breakpoint
ALTER TABLE "milestone_awards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "milestone_awards_tenant_isolation" ON "milestone_awards";
--> statement-breakpoint
CREATE POLICY "milestone_awards_tenant_isolation" ON "milestone_awards"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint
DROP POLICY IF EXISTS "milestone_awards_admin_bypass" ON "milestone_awards";
--> statement-breakpoint
CREATE POLICY "milestone_awards_admin_bypass" ON "milestone_awards"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
