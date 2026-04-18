CREATE TABLE "audit_logs" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" integer REFERENCES "orgs"("id") ON DELETE CASCADE,
  "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "action" varchar(100) NOT NULL,
  "target_type" varchar(50),
  "target_id" varchar(255),
  "metadata" jsonb,
  "ip_address" varchar(45),
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_audit_logs_org_id" ON "audit_logs" ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_audit_logs_user_id" ON "audit_logs" ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_audit_logs_action" ON "audit_logs" ("action");
--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" ("created_at");
