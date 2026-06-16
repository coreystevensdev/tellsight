-- Per Epic 9 sprint-planning decision C: digest preferences consolidate to
-- per-user (digest_preferences table); the per-membership digest_opt_in flag
-- on user_orgs predates Epic 9 and the new orchestrator never reads it.
-- Pure ALTER, no data migration, existing rows lose only the boolean field.

ALTER TABLE "user_orgs" DROP COLUMN IF EXISTS "digest_opt_in";
