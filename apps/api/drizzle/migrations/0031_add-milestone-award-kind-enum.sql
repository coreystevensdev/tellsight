-- milestone_awards.kind was a bare text column; the three valid values only
-- lived in FirstTimeMilestoneKind (TypeScript), which guards the one current
-- call site but not raw SQL, an admin script, or a future call site. A typo
-- in any of those would silently create a ledger row awardedKinds.has(...)
-- never matches again. Constrains it the same way alert_rule_fires.rule_kind
-- already is.
DO $$ BEGIN
  CREATE TYPE "milestone_award_kind" AS ENUM (
    'first_profitable_month',
    'first_break_even',
    'first_three_profitable_streak'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "milestone_awards"
  ALTER COLUMN "kind" TYPE "milestone_award_kind" USING "kind"::"milestone_award_kind";
