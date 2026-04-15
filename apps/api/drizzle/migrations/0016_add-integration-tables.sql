-- source_id column on data_rows for idempotent integration upserts
ALTER TABLE "data_rows" ADD COLUMN "source_id" VARCHAR(255);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_data_rows_source_id" ON "data_rows" ("org_id", "source_id") WHERE "source_id" IS NOT NULL;
--> statement-breakpoint

-- integration_connections table
CREATE TABLE "integration_connections" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "provider" varchar(50) NOT NULL,
  "provider_tenant_id" varchar(255) NOT NULL,
  "encrypted_refresh_token" text NOT NULL,
  "encrypted_access_token" text NOT NULL,
  "access_token_expires_at" timestamptz NOT NULL,
  "scope" varchar(500),
  "last_synced_at" timestamptz,
  "sync_status" varchar(20) NOT NULL DEFAULT 'idle',
  "sync_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_integration_connections_org_provider" ON "integration_connections" ("org_id", "provider");
--> statement-breakpoint

-- sync_jobs table
CREATE TABLE "sync_jobs" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" integer NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "connection_id" integer NOT NULL REFERENCES "integration_connections"("id") ON DELETE CASCADE,
  "trigger" varchar(20) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'queued',
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "rows_synced" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_sync_jobs_connection_id" ON "sync_jobs" ("connection_id");
--> statement-breakpoint
CREATE INDEX "idx_sync_jobs_org_id" ON "sync_jobs" ("org_id");
--> statement-breakpoint

-- RLS: integration_connections
ALTER TABLE "integration_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "integration_connections_tenant_isolation" ON "integration_connections"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint
CREATE POLICY "integration_connections_admin_bypass" ON "integration_connections"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
--> statement-breakpoint

-- RLS: sync_jobs
ALTER TABLE "sync_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sync_jobs_tenant_isolation" ON "sync_jobs"
  FOR ALL
  USING (org_id = current_setting('app.current_org_id', true)::integer)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::integer);
--> statement-breakpoint
CREATE POLICY "sync_jobs_admin_bypass" ON "sync_jobs"
  FOR ALL
  USING (COALESCE(current_setting('app.is_admin', true)::boolean, false) = true);
