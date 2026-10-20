-- An owner's intended monthly spend per category, which the variance stat reads
-- against the actuals computeCategoryBreakdown already produces.
--
-- Deliberately not keyed to a dataset. A plan is the owner's intent and outlives
-- any single upload; keying it to dataset_id would silently discard every plan
-- the next time someone re-uploads a CSV. category is varchar(255) to match
-- data_rows.category exactly, including the fact that it is free text from the
-- source rather than a controlled vocabulary.
CREATE TABLE IF NOT EXISTS "category_plans" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "category" varchar(255) NOT NULL,
  -- Same precision as data_rows.amount, so a comparison never drifts on scale.
  "planned_monthly" numeric(12, 2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One plan per category per org. A row existing is what "a plan is set" means,
-- so removing a plan is a delete rather than a null, and there is no
-- unset-versus-zero ambiguity for the variance stat to interpret.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_category_plans_org_category" ON "category_plans" ("org_id", "category");
--> statement-breakpoint
ALTER TABLE "category_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "category_plans_tenant_isolation" ON "category_plans";
--> statement-breakpoint
CREATE POLICY "category_plans_tenant_isolation" ON "category_plans"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint
DROP POLICY IF EXISTS "category_plans_admin_bypass" ON "category_plans";
--> statement-breakpoint
CREATE POLICY "category_plans_admin_bypass" ON "category_plans"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
