-- One email when a paying org's weekly digest goes quiet, not one a week.
--
-- Compared against the active dataset's created_at rather than being a plain
-- "already told them" flag, which is what makes it reset on its own: uploading
-- mints a new datasets row with a newer created_at, so an org that goes stale a
-- second time months later is nudged again with nothing to clear in between.
ALTER TABLE "orgs"
  ADD COLUMN IF NOT EXISTS "stale_nudge_sent_at" timestamp with time zone;
