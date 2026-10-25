-- The contract half of the year-over-year rename. 0043 added currentRevenue and
-- priorRevenue alongside the mislabelled currentYear and priorYear; this removes
-- the old pair now that no image anyone would roll back to still reads them.
--
-- Safe because the last six deploys all read currentRevenue: the reader changed
-- in 1108052 and the first image that needs currentYear is seven deploys back.
-- A rollback past that point degrades rather than breaks, since isComputedStat
-- drops an entry whose discriminator field is missing instead of throwing, so
-- the cost is a digest losing year-over-year entries from its prior context.
--
-- Only year_over_year entries are touched and only when the new key is already
-- present, so this cannot strip the old key off a row that 0043 never reached,
-- and re-running it changes nothing.
UPDATE "digest_history"
SET "key_stats" = (
  SELECT jsonb_agg(
    CASE
      WHEN elem->>'statType' = 'year_over_year'
       AND elem->'details' ? 'currentRevenue'
      THEN jsonb_set(
             elem,
             '{details}',
             (elem->'details') - 'currentYear' - 'priorYear'
           )
      ELSE elem
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements("key_stats") WITH ORDINALITY AS t(elem, ord)
)
WHERE jsonb_array_length("key_stats") > 0
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("key_stats") e
    WHERE e->>'statType' = 'year_over_year'
      AND e->'details' ? 'currentRevenue'
      AND (e->'details' ? 'currentYear' OR e->'details' ? 'priorYear')
  );
