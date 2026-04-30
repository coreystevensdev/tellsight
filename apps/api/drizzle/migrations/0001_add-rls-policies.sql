-- RLS policies for tenant tables (defense-in-depth behind application-level org_id filtering)
-- Application sets per-request: SET LOCAL app.current_org_id = X; SET LOCAL app.is_admin = false;
-- These policies serve as a safety net, primary enforcement is in db/queries/*.ts

-- Enable RLS on tenant tables with org_id columns
ALTER TABLE "user_orgs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Tenant isolation: user_orgs, only rows matching the current org
-- WITH CHECK mirrors USING to prevent cross-tenant INSERT/UPDATE
CREATE POLICY "user_orgs_tenant_isolation" ON "user_orgs"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint

-- Tenant isolation: refresh_tokens, only rows matching the current org
CREATE POLICY "refresh_tokens_tenant_isolation" ON "refresh_tokens"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint

-- Platform admin bypass: user_orgs, admins can see all rows
-- COALESCE ensures NULL (unset setting) is treated as false, not left to SQL three-valued logic
CREATE POLICY "user_orgs_admin_bypass" ON "user_orgs"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
--> statement-breakpoint

-- Platform admin bypass: refresh_tokens, admins can see all rows
CREATE POLICY "refresh_tokens_admin_bypass" ON "refresh_tokens"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
