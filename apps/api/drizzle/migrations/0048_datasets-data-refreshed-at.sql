-- DW-281. Connector syncs reuse one dataset per provider and rewrite its rows,
-- so created_at freezes at first connect while the data changes daily. Three
-- call sites read created_at as "when did this org last receive data", which is
-- true for CSV and false for every connector: the 30-day eligibility gate, the
-- stale-data nudge, and prepareDigestContext's no-new-data skip.
--
-- Deliberately not called updated_at. updateDatasetName mutates a dataset too,
-- and a rename is not new data; a generic name invites touching this on any
-- mutation and would report a renamed dataset as freshly refreshed.
ALTER TABLE datasets ADD COLUMN data_refreshed_at timestamptz;

-- Backfill to created_at, which is exactly right for CSV (one upload, one
-- dataset, never rewritten) and is the best available lower bound for the three
-- existing connector datasets. Those three are then corrected below.
UPDATE datasets SET data_refreshed_at = created_at WHERE data_refreshed_at IS NULL;

-- The connector datasets have been syncing daily while created_at stood still,
-- so created_at understates them by weeks. integration_connections.last_synced_at
-- is the honest value for the rows currently in them.
UPDATE datasets d
SET data_refreshed_at = GREATEST(d.created_at, ic.last_synced_at)
FROM integration_connections ic
WHERE ic.org_id = d.org_id
  AND ic.provider = d.source_type::text
  AND ic.last_synced_at IS NOT NULL;

-- DEFAULT first, then NOT NULL. The previous release does not know this column
-- exists, so its createDataset insert omits it; the default is what keeps that
-- insert working if the image is rolled back while the schema stays.
ALTER TABLE datasets ALTER COLUMN data_refreshed_at SET DEFAULT now();
ALTER TABLE datasets ALTER COLUMN data_refreshed_at SET NOT NULL;

-- The eligibility gate and the stale nudge both filter on this now, and the
-- nudge compares it against orgs.stale_nudge_sent_at.
CREATE INDEX IF NOT EXISTS idx_datasets_data_refreshed_at ON datasets (data_refreshed_at);
