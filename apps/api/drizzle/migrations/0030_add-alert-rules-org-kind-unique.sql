-- Partial unique index on alert_rules (org_id, kind): closes the gap where
-- an org could create unbounded duplicate rules of the same kind, which
-- would fire duplicate alert emails once the same condition trips. Partial
-- on deleted_at IS NULL, not enabled, so a soft-deleted rule doesn't block
-- recreating that kind but a disabled duplicate still can't accumulate.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_alert_rules_org_kind_active"
  ON "alert_rules" ("org_id", "kind")
  WHERE "deleted_at" IS NULL;
