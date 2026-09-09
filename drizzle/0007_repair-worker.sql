CREATE TABLE "repair_run_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"repair_run_id" text NOT NULL,
	"queue_job_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"expected_baseline_id" text NOT NULL,
	"ownership_token" text NOT NULL,
	"state" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"baseline_id" text,
	"sandbox_name" text,
	"sandbox_session_id" text,
	"cleanup_stop" text,
	"cleanup_delete" text,
	"cleanup_lookup" text,
	"failure_classification" text,
	"failure_code" text,
	CONSTRAINT "repair_run_attempt_expected_baseline_id_unique" UNIQUE("expected_baseline_id"),
	CONSTRAINT "repair_run_attempt_baseline_id_unique" UNIQUE("baseline_id"),
	CONSTRAINT "repair_run_attempt_id_check" CHECK ("repair_run_attempt"."id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_run_attempt_job_check" CHECK ("repair_run_attempt"."queue_job_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_run_attempt_evidence_check" CHECK ("repair_run_attempt"."expected_baseline_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_run_attempt_owner_check" CHECK ("repair_run_attempt"."ownership_token" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_run_attempt_number_check" CHECK ("repair_run_attempt"."attempt_number" between 1 and 3),
	CONSTRAINT "repair_run_attempt_state_check" CHECK ("repair_run_attempt"."state" in ('active','succeeded','customer_failed','retryable_failed','exhausted','abandoned')),
	CONSTRAINT "repair_run_attempt_lease_check" CHECK (("repair_run_attempt"."state" = 'active' and "repair_run_attempt"."lease_expires_at" is not null and "repair_run_attempt"."finished_at" is null) or ("repair_run_attempt"."state" <> 'active' and "repair_run_attempt"."lease_expires_at" is null and "repair_run_attempt"."finished_at" is not null)),
	CONSTRAINT "repair_run_attempt_sandbox_check" CHECK (("repair_run_attempt"."sandbox_name" is null or "repair_run_attempt"."sandbox_name" ~ '^[a-z0-9][a-z0-9-]{0,99}$') and ("repair_run_attempt"."sandbox_session_id" is null or "repair_run_attempt"."sandbox_session_id" ~ '^[A-Za-z0-9_-]{1,128}$')),
	CONSTRAINT "repair_run_attempt_cleanup_check" CHECK (("repair_run_attempt"."cleanup_stop" is null or "repair_run_attempt"."cleanup_stop" in ('confirmed','failed','not_needed')) and ("repair_run_attempt"."cleanup_delete" is null or "repair_run_attempt"."cleanup_delete" in ('confirmed','failed','not_needed')) and ("repair_run_attempt"."cleanup_lookup" is null or "repair_run_attempt"."cleanup_lookup" in ('absent','still_present','unconfirmed','unconfirmed_after_create_failure','not_run'))),
	CONSTRAINT "repair_run_attempt_failure_check" CHECK (("repair_run_attempt"."failure_classification" is null or "repair_run_attempt"."failure_classification" in ('customer_baseline_failure','infrastructure_failure','process_loss')) and ("repair_run_attempt"."failure_code" is null or "repair_run_attempt"."failure_code" ~ '^[a-z_]{1,64}$'))
);
--> statement-breakpoint
ALTER TABLE "repair_run_attempt" ADD CONSTRAINT "repair_run_attempt_repair_run_id_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "public"."repair_run"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repair_run_attempt" ADD CONSTRAINT "repair_run_attempt_baseline_id_repository_baseline_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."repository_baseline"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "repair_run_attempt_number_unique" ON "repair_run_attempt" USING btree ("repair_run_id","attempt_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "repair_run_attempt_active_unique" ON "repair_run_attempt" USING btree ("repair_run_id") WHERE "state" = 'active';
--> statement-breakpoint
CREATE INDEX "repair_run_attempt_run_idx" ON "repair_run_attempt" USING btree ("repair_run_id","claimed_at");
