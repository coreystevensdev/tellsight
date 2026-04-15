ALTER TABLE "orgs" ADD COLUMN "active_dataset_id" integer;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_active_dataset_id_datasets_id_fk" FOREIGN KEY ("active_dataset_id") REFERENCES "public"."datasets"("id") ON DELETE set null ON UPDATE no action;
