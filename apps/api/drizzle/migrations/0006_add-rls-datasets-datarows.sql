-- RLS policies for datasets and data_rows tables
-- Same defense-in-depth pattern as 0001: tenant isolation + admin bypass

ALTER TABLE "datasets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "data_rows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Tenant isolation: datasets, only rows matching the current org
CREATE POLICY "datasets_tenant_isolation" ON "datasets"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint

-- Platform admin bypass: datasets, admins can see all rows
CREATE POLICY "datasets_admin_bypass" ON "datasets"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
--> statement-breakpoint

-- Tenant isolation: data_rows, only rows matching the current org
CREATE POLICY "data_rows_tenant_isolation" ON "data_rows"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint

-- Platform admin bypass: data_rows, admins can see all rows
CREATE POLICY "data_rows_admin_bypass" ON "data_rows"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
