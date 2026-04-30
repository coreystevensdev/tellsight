-- RLS policy for shares table, defense-in-depth behind application-level org_id filtering

ALTER TABLE "shares" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Tenant isolation: shares
CREATE POLICY "shares_tenant_isolation" ON "shares"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint

-- Admin bypass: shares, platform admins can view all shares
CREATE POLICY "shares_admin_bypass" ON "shares"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
