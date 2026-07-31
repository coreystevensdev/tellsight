-- Optional dedupe key on analytics_events so callers that can double-fire
-- (e.g. two tabs hitting the mute/unmute token routes at once) can opt into
-- ON CONFLICT DO NOTHING instead of recording duplicate rows.
ALTER TABLE "analytics_events" ADD COLUMN "dedupe_key" varchar(200);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_analytics_events_dedupe_key"
  ON "analytics_events" ("dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;
