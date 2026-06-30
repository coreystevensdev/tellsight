-- Story 18.1: agent_enabled on subscriptions + agent_proposals table.
--
-- agent_enabled: capability flag that gates the nightly agent run and the
-- action drawer. Separate from plan so Agent stays an add-on to Pro without
-- requiring every Pro-gating query to add 'agent' as an allowed plan value.
--
-- agent_proposals: persisted gate output. Only auto_notify and needs_approval
-- lanes are stored; suppress is discarded after logging. RLS mirrors the
-- digest_history pattern: org-scoped for tenant reads, admin bypass for the
-- nightly worker.

ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "agent_enabled" boolean NOT NULL DEFAULT false;

--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "agent_proposal_status" AS ENUM (
    'pending',
    'approved',
    'rejected',
    'expired',
    'notified'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_proposals" (
  "id"                   integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id"               integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "kind"                 text NOT NULL,
  "severity"             text NOT NULL,
  "title"                varchar(120) NOT NULL,
  "explanation"          text NOT NULL,
  "recommendation"       text NOT NULL,
  "confidence"           numeric(4, 3) NOT NULL,
  "evidence"             jsonb NOT NULL,
  "action"               jsonb,
  "dedup_key"            text NOT NULL,
  "lane"                 text NOT NULL,
  "period"               text NOT NULL,
  "status"               "agent_proposal_status" NOT NULL DEFAULT 'pending',
  "created_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"           timestamp with time zone NOT NULL,
  "resolved_at"          timestamp with time zone,
  "resolved_by_user_id"  integer REFERENCES "users"("id") ON DELETE SET NULL
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_agent_proposals_org_status"
  ON "agent_proposals" ("org_id", "status");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_agent_proposals_org_dedup_key"
  ON "agent_proposals" ("org_id", "dedup_key");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_agent_proposals_expires_at"
  ON "agent_proposals" ("expires_at")
  WHERE "status" = 'pending';

--> statement-breakpoint

ALTER TABLE "agent_proposals" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

DROP POLICY IF EXISTS "agent_proposals_tenant_isolation" ON "agent_proposals";

--> statement-breakpoint

CREATE POLICY "agent_proposals_tenant_isolation" ON "agent_proposals"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);

--> statement-breakpoint

DROP POLICY IF EXISTS "agent_proposals_admin_bypass" ON "agent_proposals";

--> statement-breakpoint

CREATE POLICY "agent_proposals_admin_bypass" ON "agent_proposals"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
