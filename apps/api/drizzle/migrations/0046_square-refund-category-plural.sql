-- DW-236: Square wrote category 'Refund' while QuickBooks and Shopify wrote
-- 'Refunds'. category is set per row at sync time, so fixing the writer alone
-- would have split Square's own history across two spellings until every
-- refunded order happened to be touched again. Measured on production before
-- this ran: one org held 2 'Refund' rows from Square and 2 'Refunds' rows from
-- QuickBooks, so its category breakdown listed refunds twice.
--
-- Scoped to source_type = 'square' on purpose. A CSV category is whatever the
-- owner typed, so an uploaded column reading 'Refund' is their word for their
-- data and renaming it would be editing their input rather than fixing ours.
--
-- Idempotent: a second run matches nothing, since no square row is left on the
-- singular. category carries no unique index, so merging these rows into the
-- category that already exists is a plain update rather than a conflict.
UPDATE "data_rows"
SET "category" = 'Refunds'
WHERE "source_type" = 'square'
  AND "category" = 'Refund';
