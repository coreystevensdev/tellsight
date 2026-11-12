-- audit_logs was the one table carrying org_id with no policy, and the schema
-- gate test listed it under NOT_ORG_SCOPED, so the gap was asserted as correct.
--
-- No behaviour change today: every read and write goes through dbAdmin, which
-- connects as the migration role and bypasses RLS. This is the backstop for the
-- first org-facing audit view that uses the restricted client.
--
-- org_id is nullable on purpose, for platform-level events with no org. Those
-- rows stay invisible to tenants (NULL = n is never true) and visible to admins
-- through the bypass policy, which is the behaviour we want.

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Tenant isolation: audit_logs
CREATE POLICY "audit_logs_tenant_isolation" ON "audit_logs"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint

-- Admin bypass: audit_logs, platform admins read across orgs and see the
-- org-less platform events
CREATE POLICY "audit_logs_admin_bypass" ON "audit_logs"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
