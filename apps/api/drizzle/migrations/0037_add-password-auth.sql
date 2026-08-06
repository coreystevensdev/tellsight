-- Email/password sign-up as a second auth path alongside Google OAuth.
-- password_hash is nullable, Google-only accounts never get one, and the
-- login route rejects credential-based sign-in for accounts without one.
ALTER TABLE "users" ADD COLUMN "password_hash" varchar(255);
--> statement-breakpoint

-- Same shape as org_invites: hashed one-time token, expiry, used_at. No
-- org_id, a password reset is user-scoped and happens before any org
-- context exists, same reasoning that keeps the users table itself outside
-- the RLS/tenant-isolation model.
CREATE TABLE "password_reset_tokens" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "token_hash" varchar(255) NOT NULL UNIQUE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX "idx_password_reset_tokens_user_id" ON "password_reset_tokens" ("user_id");
--> statement-breakpoint

CREATE INDEX "idx_password_reset_tokens_token_hash" ON "password_reset_tokens" ("token_hash");
