-- RLS policy for subscriptions table, defense-in-depth behind application-level org_id filtering

ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Tenant isolation: subscriptions
CREATE POLICY "subscriptions_tenant_isolation" ON "subscriptions"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint

-- Admin bypass: subscriptions, platform admins can view all subscriptions
CREATE POLICY "subscriptions_admin_bypass" ON "subscriptions"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
