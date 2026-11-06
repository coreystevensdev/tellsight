-- DW-237: source_id was built as "<id>-<lineId>" with no entity type in it, so
-- it is only a key if QuickBooks allocates Id globally. Intuit does not document
-- the scope. If allocation is per entity type, Invoice 501 line 1 and Purchase
-- 501 line 1 both produce "501-1" and the second upsert against
-- (org_id, source_id) overwrites the first, an expense replacing a sale or the
-- reverse depending on which type synced last.
--
-- Measured 2026-11-06 against the one realm observable: ids there come from a
-- single sequence shared across entity types, interleaving 1..144 across eleven
-- types with no id under two of them. So no collision has happened and none was
-- reachable. That is n=1, a sandbox company, and an undocumented invariant, which
-- is why the key is being fixed rather than relied on.
--
-- normalize.ts now builds source_id as "<txnType>-<id>-<lineId>". This rewrites
-- existing quickbooks rows into that shape so the next sync's keys land on the
-- rows already here. txnType comes from metadata->>'txnType', which normalize.ts
-- has written since the connector's first commit, so every row already carries
-- what it needs to rewrite itself. Production holds 179 such rows, every one in
-- the old shape, in a single org.
--
-- Idempotent: a row is only touched when its source_id does not already start
-- with its own txnType prefix, so a second run finds nothing to do. Safe on zero
-- quickbooks rows as well.
--
-- What this cannot do: if a collision ever did occur, the losing transaction's
-- row was overwritten in place and its data was never stored anywhere to recover
-- it from. No such row is known to exist. This removes the hazard going forward;
-- it cannot restore anything a past collision erased.
UPDATE "data_rows"
SET "source_id" = ("metadata"->>'txnType') || '-' || "source_id"
WHERE "source_type" = 'quickbooks'
  AND "metadata"->>'txnType' IS NOT NULL
  AND "source_id" IS NOT NULL
  AND "source_id" NOT LIKE ("metadata"->>'txnType') || '-%';
