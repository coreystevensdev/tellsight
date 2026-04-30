-- RLS policies for analytics_events and org_invites
-- Catches up org_invites (deferred from Story 1.5) and adds analytics_events

ALTER TABLE "analytics_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org_invites" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Tenant isolation: analytics_events
CREATE POLICY "analytics_events_tenant_isolation" ON "analytics_events"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint

-- Admin bypass: analytics_events, platform admins see all events for system-wide reporting
CREATE POLICY "analytics_events_admin_bypass" ON "analytics_events"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
--> statement-breakpoint

-- Tenant isolation: org_invites
CREATE POLICY "org_invites_tenant_isolation" ON "org_invites"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint

-- Admin bypass: org_invites
CREATE POLICY "org_invites_admin_bypass" ON "org_invites"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
