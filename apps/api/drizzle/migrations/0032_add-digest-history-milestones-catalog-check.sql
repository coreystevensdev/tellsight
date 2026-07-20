-- digest_history.milestones jsonb entries mix two catalogs (MilestoneKind's
-- 7 transition values and FirstTimeMilestoneKind's 3 all-time-first values)
-- with nothing distinguishing which one a given entry's kind belongs to.
-- Backfill tags existing rows before the CHECK lands, so pre-existing rows
-- never violate it.
UPDATE "digest_history"
SET "milestones" = (
  SELECT COALESCE(
    jsonb_agg(
      elem || jsonb_build_object(
        'catalog',
        CASE
          WHEN elem->>'kind' IN ('first_profitable_month', 'first_break_even', 'first_three_profitable_streak')
            THEN 'first_time'
          ELSE 'transition'
        END
      )
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements("milestones") AS elem
)
WHERE jsonb_array_length("milestones") > 0;
--> statement-breakpoint
ALTER TABLE "digest_history" DROP CONSTRAINT IF EXISTS "digest_history_milestones_catalog_check";
--> statement-breakpoint
-- jsonpath's lax mode treats a missing member as "unknown", not a match, so
-- a bare "@.catalog != ..." predicate silently lets an entry with no catalog
-- key through. !exists(@.catalog) closes that gap.
ALTER TABLE "digest_history" ADD CONSTRAINT "digest_history_milestones_catalog_check" CHECK (
  NOT jsonb_path_exists("milestones", '$[*] ? (!exists(@.catalog) || (@.catalog != "first_time" && @.catalog != "transition"))')
);
