DO $$ BEGIN
  CREATE TYPE "stat_correction_status" AS ENUM ('pending', 'approved', 'rejected', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stat_corrections" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "dataset_id" integer NOT NULL REFERENCES "datasets"("id") ON DELETE CASCADE,
  "stat_instance_id" text NOT NULL,
  "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "note" text NOT NULL,
  "applies_going_forward" boolean NOT NULL DEFAULT false,
  "status" "stat_correction_status",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "resolved_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stat_corrections_org_dataset" ON "stat_corrections" ("org_id", "dataset_id");
--> statement-breakpoint
-- Enforces the one-active-Tier-2-request-per-stat rule at the DB layer (409
-- on conflict), the same job idx_alert_rules_org_kind_active does for rules.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_stat_corrections_org_stat_active" ON "stat_corrections" ("org_id", "stat_instance_id")
  WHERE "status" IN ('pending', 'approved');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stat_corrections_expires_at" ON "stat_corrections" ("expires_at")
  WHERE "status" IN ('pending', 'approved');
--> statement-breakpoint
ALTER TABLE "stat_corrections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "stat_corrections_tenant_isolation" ON "stat_corrections";
--> statement-breakpoint
CREATE POLICY "stat_corrections_tenant_isolation" ON "stat_corrections"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint
DROP POLICY IF EXISTS "stat_corrections_admin_bypass" ON "stat_corrections";
--> statement-breakpoint
CREATE POLICY "stat_corrections_admin_bypass" ON "stat_corrections"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
