-- DW-280. Customer concentration is the highest-demand insight the product
-- cannot compute, because nothing records who a row was with. category and
-- parent_category describe what the money was for, and label is free text (433
-- of 1,694 rows have one at all), so neither can be grouped on.
--
-- Added ahead of any consumer on purpose: counterparty data cannot be recovered
-- retroactively. A row ingested without it is permanently anonymous, so the
-- column has to exist before the rows arrive or the history is lost.
--
-- Nullable with no backfill. Every existing row genuinely has no counterparty,
-- and a default would invent one.
ALTER TABLE data_rows ADD COLUMN counterparty varchar(255);

-- A concentration stat groups revenue by counterparty within an org and dataset,
-- which is the access pattern this serves. Partial, because the column is null
-- for every row ingested before today and for every source that does not carry
-- one, and indexing those buys nothing.
CREATE INDEX IF NOT EXISTS idx_data_rows_counterparty
  ON data_rows (org_id, dataset_id, counterparty)
  WHERE counterparty IS NOT NULL;
