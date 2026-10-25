-- digest_history.key_stats year_over_year entries carried the month's revenue
-- dollars under the keys currentYear and priorYear. The years themselves were
-- only ever in currentYearLabel/priorYearLabel, so a citation id built from
-- details.currentYear read as a dollar amount while looking like a year.
--
-- This is the expand half. The correctly named keys are added and the old ones
-- are left in place, because a rollback re-pins the previous image without
-- rolling back the database, and the previous reader dereferences
-- details.currentYear. Finding nothing it drops the stat from prior context
-- silently instead of failing, which is the quietest kind of regression.
-- Dropping the old keys is DW-220, once no deployed version reads them.
--
-- Nothing is rewritten for non-year_over_year entries, and an entry that
-- already has currentRevenue is left alone so this is safe to re-run.
UPDATE "digest_history"
SET "key_stats" = (
  SELECT jsonb_agg(
    CASE
      WHEN elem->>'statType' = 'year_over_year'
       AND elem->'details' ? 'currentYear'
       AND NOT (elem->'details' ? 'currentRevenue')
      THEN jsonb_set(
             jsonb_set(elem, '{details,currentRevenue}', elem->'details'->'currentYear'),
             '{details,priorRevenue}', COALESCE(elem->'details'->'priorYear', 'null'::jsonb)
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
      AND e->'details' ? 'currentYear'
      AND NOT (e->'details' ? 'currentRevenue')
  );
