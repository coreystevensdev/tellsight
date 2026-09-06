-- schema.ts has declared idx_analytics_events_ai_usage since the AI cost tile
-- landed, and no migration ever created it. Nothing noticed, because the drift
-- check compared columns and nullability only; widening it to indexes found this
-- on the first run.
--
-- getAnalyticsEvents filters on org_id, event_name and a created_at range
-- together, which is what this composite serves. Without it that query falls
-- back to the single-column org_id index and filters the rest by scan.
CREATE INDEX IF NOT EXISTS "idx_analytics_events_ai_usage"
  ON "analytics_events" ("org_id", "event_name", "created_at");
