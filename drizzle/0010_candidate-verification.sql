CREATE TABLE "candidate_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"investigation_id" text NOT NULL,
	"repair_run_id" text NOT NULL,
	"baseline_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"base_commit_sha" text NOT NULL,
	"profile_identity" text NOT NULL,
	"candidate_identity" text NOT NULL,
	"format_version" integer NOT NULL,
	"state" text NOT NULL,
	"candidate_artifact_integrity" text,
	"verification_contract" text,
	"baseline_comparison" text,
	"repair_objective_evidence" text DEFAULT 'not_measured' NOT NULL,
	"evidence_id" text UNIQUE,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone NOT NULL,
	"verification_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_verification_id_check" CHECK ("candidate_verification"."id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "candidate_verification_commit_check" CHECK ("candidate_verification"."base_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "candidate_verification_hashes_check" CHECK ("candidate_verification"."profile_identity" ~ '^[0-9a-f]{64}$' and "candidate_verification"."candidate_identity" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "candidate_verification_version_check" CHECK ("candidate_verification"."format_version" = 1),
	CONSTRAINT "candidate_verification_state_check" CHECK ("candidate_verification"."state" in ('created','queued','verifying','completed','infrastructure_failed','cancelled')),
	CONSTRAINT "candidate_verification_results_check" CHECK (("candidate_verification"."candidate_artifact_integrity" is null or "candidate_verification"."candidate_artifact_integrity" in ('valid','invalid')) and ("candidate_verification"."verification_contract" is null or "candidate_verification"."verification_contract" in ('checks_passed','checks_failed','infrastructure_failed')) and ("candidate_verification"."baseline_comparison" is null or "candidate_verification"."baseline_comparison" in ('no_regression_detected','regression_detected','previous_baseline_failure_resolved','previous_baseline_failure_still_present','not_comparable')) and "candidate_verification"."repair_objective_evidence" = 'not_measured' and ("candidate_verification"."failure_code" is null or "candidate_verification"."failure_code" ~ '^[a-z_]{1,64}$')),
	CONSTRAINT "candidate_verification_state_facts_check" CHECK (("candidate_verification"."state" in ('created','queued') and "candidate_verification"."verification_started_at" is null and "candidate_verification"."completed_at" is null and "candidate_verification"."evidence_id" is null and "candidate_verification"."candidate_artifact_integrity" is null and "candidate_verification"."verification_contract" is null and "candidate_verification"."baseline_comparison" is null and "candidate_verification"."failure_code" is null) or ("candidate_verification"."state" = 'verifying' and "candidate_verification"."verification_started_at" is not null and "candidate_verification"."completed_at" is null and "candidate_verification"."evidence_id" is null and "candidate_verification"."verification_contract" is null and "candidate_verification"."baseline_comparison" is null) or ("candidate_verification"."state" = 'completed' and "candidate_verification"."verification_started_at" is not null and "candidate_verification"."completed_at" is not null and "candidate_verification"."evidence_id" is not null and "candidate_verification"."candidate_artifact_integrity" = 'valid' and "candidate_verification"."verification_contract" in ('checks_passed','checks_failed') and "candidate_verification"."baseline_comparison" is not null and "candidate_verification"."failure_code" is null) or ("candidate_verification"."state" = 'infrastructure_failed' and "candidate_verification"."verification_started_at" is not null and "candidate_verification"."completed_at" is not null and "candidate_verification"."verification_contract" = 'infrastructure_failed' and "candidate_verification"."baseline_comparison" = 'not_comparable' and "candidate_verification"."failure_code" is not null) or ("candidate_verification"."state" = 'cancelled' and "candidate_verification"."completed_at" is not null and "candidate_verification"."baseline_comparison" = 'not_comparable' and "candidate_verification"."failure_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "candidate_verification_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"verification_id" text NOT NULL,
	"queue_job_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"expected_evidence_id" text NOT NULL UNIQUE,
	"ownership_token" text NOT NULL,
	"state" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"evidence_id" text UNIQUE,
	"sandbox_name" text,
	"sandbox_session_id" text,
	"cleanup_stop" text,
	"cleanup_delete" text,
	"cleanup_lookup" text,
	"failure_code" text,
	CONSTRAINT "candidate_verification_attempt_uuid_check" CHECK ("candidate_verification_attempt"."id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "candidate_verification_attempt"."queue_job_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "candidate_verification_attempt"."expected_evidence_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "candidate_verification_attempt"."ownership_token" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "candidate_verification_attempt_number_check" CHECK ("candidate_verification_attempt"."attempt_number" between 1 and 3),
	CONSTRAINT "candidate_verification_attempt_state_check" CHECK ("candidate_verification_attempt"."state" in ('active','succeeded','checks_failed','retryable_failed','exhausted','abandoned')),
	CONSTRAINT "candidate_verification_attempt_lease_check" CHECK (("candidate_verification_attempt"."state" = 'active' and "candidate_verification_attempt"."lease_expires_at" is not null and "candidate_verification_attempt"."finished_at" is null) or ("candidate_verification_attempt"."state" <> 'active' and "candidate_verification_attempt"."lease_expires_at" is null and "candidate_verification_attempt"."finished_at" is not null)),
	CONSTRAINT "candidate_verification_attempt_sandbox_check" CHECK (("candidate_verification_attempt"."sandbox_name" is null or "candidate_verification_attempt"."sandbox_name" ~ '^[a-z0-9][a-z0-9-]{0,99}$') and ("candidate_verification_attempt"."sandbox_session_id" is null or "candidate_verification_attempt"."sandbox_session_id" ~ '^[A-Za-z0-9_-]{1,128}$')),
	CONSTRAINT "candidate_verification_attempt_cleanup_check" CHECK (("candidate_verification_attempt"."cleanup_stop" is null or "candidate_verification_attempt"."cleanup_stop" in ('confirmed','failed','not_needed')) and ("candidate_verification_attempt"."cleanup_delete" is null or "candidate_verification_attempt"."cleanup_delete" in ('confirmed','failed','not_needed')) and ("candidate_verification_attempt"."cleanup_lookup" is null or "candidate_verification_attempt"."cleanup_lookup" in ('absent','still_present','unconfirmed','unconfirmed_after_create_failure','not_run')) and ("candidate_verification_attempt"."failure_code" is null or "candidate_verification_attempt"."failure_code" ~ '^[a-z_]{1,64}$'))
);
--> statement-breakpoint
CREATE TABLE "candidate_verification_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"verification_id" text NOT NULL,
	"attempt_id" text NOT NULL UNIQUE,
	"evidence_version" integer NOT NULL,
	"candidate_id" text NOT NULL,
	"candidate_identity" text NOT NULL,
	"workspace_id" text NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"base_commit_sha" text NOT NULL,
	"profile_identity" text NOT NULL,
	"baseline_id" text NOT NULL,
	"candidate_artifact_integrity" text NOT NULL,
	"sandbox_name" text NOT NULL,
	"sandbox_session_id" text,
	"distinct_sandbox_confirmed" boolean NOT NULL,
	"pristine_source_identity" text,
	"pristine_base_integrity" text NOT NULL,
	"reconstructed_source_identity" text,
	"candidate_reconstruction" text NOT NULL,
	"credentials_exposure" text NOT NULL,
	"network_policy" text NOT NULL,
	"install_status" text NOT NULL,
	"install_exit_code" integer,
	"install_timed_out" boolean NOT NULL,
	"typecheck_status" text,
	"typecheck_exit_code" integer,
	"typecheck_timed_out" boolean,
	"build_status" text,
	"build_exit_code" integer,
	"build_timed_out" boolean,
	"test_status" text NOT NULL,
	"test_exit_code" integer,
	"test_timed_out" boolean NOT NULL,
	"source_identity_after" text,
	"source_integrity_unchanged" boolean,
	"cleanup_stop" text NOT NULL,
	"cleanup_delete" text NOT NULL,
	"cleanup_lookup" text NOT NULL,
	"execution_outcome" text NOT NULL,
	"verification_contract" text NOT NULL,
	"baseline_comparison" text NOT NULL,
	"repair_objective_evidence" text NOT NULL,
	"error_phase" text,
	"error_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	CONSTRAINT "candidate_verification_evidence_version_check" CHECK ("candidate_verification_evidence"."evidence_version" = 1),
	CONSTRAINT "candidate_verification_evidence_hash_check" CHECK ("candidate_verification_evidence"."candidate_identity" ~ '^[0-9a-f]{64}$' and "candidate_verification_evidence"."profile_identity" ~ '^[0-9a-f]{64}$' and "candidate_verification_evidence"."base_commit_sha" ~ '^[0-9a-f]{40}$' and ("candidate_verification_evidence"."pristine_source_identity" is null or "candidate_verification_evidence"."pristine_source_identity" ~ '^[0-9a-f]{64}$') and ("candidate_verification_evidence"."reconstructed_source_identity" is null or "candidate_verification_evidence"."reconstructed_source_identity" ~ '^[0-9a-f]{64}$') and ("candidate_verification_evidence"."source_identity_after" is null or "candidate_verification_evidence"."source_identity_after" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "candidate_verification_evidence_integrity_check" CHECK ("candidate_verification_evidence"."candidate_artifact_integrity" in ('valid','invalid') and "candidate_verification_evidence"."pristine_base_integrity" in ('valid','invalid','not_checked') and "candidate_verification_evidence"."candidate_reconstruction" in ('valid','invalid','not_checked') and "candidate_verification_evidence"."credentials_exposure" in ('absent','present','not_checked') and "candidate_verification_evidence"."network_policy" in ('deny-all','unconfirmed')),
	CONSTRAINT "candidate_verification_evidence_phase_check" CHECK ("candidate_verification_evidence"."install_status" in ('not_run','completed','failed','timed_out') and ("candidate_verification_evidence"."typecheck_status" is null or "candidate_verification_evidence"."typecheck_status" in ('not_run','completed','failed','timed_out')) and ("candidate_verification_evidence"."build_status" is null or "candidate_verification_evidence"."build_status" in ('not_run','completed','failed','timed_out')) and "candidate_verification_evidence"."test_status" in ('not_run','completed','failed','timed_out')),
	CONSTRAINT "candidate_verification_evidence_cleanup_check" CHECK ("candidate_verification_evidence"."cleanup_stop" in ('confirmed','failed','not_needed') and "candidate_verification_evidence"."cleanup_delete" in ('confirmed','failed','not_needed') and "candidate_verification_evidence"."cleanup_lookup" in ('absent','still_present','unconfirmed','unconfirmed_after_create_failure','not_run')),
	CONSTRAINT "candidate_verification_evidence_result_check" CHECK ("candidate_verification_evidence"."execution_outcome" in ('checks_passed','typecheck_failed','build_failed','test_failed','installation_failed','timed_out','cancelled','infrastructure_failed','cleanup_failed','artifact_invalid') and "candidate_verification_evidence"."verification_contract" in ('checks_passed','checks_failed','infrastructure_failed') and "candidate_verification_evidence"."baseline_comparison" in ('no_regression_detected','regression_detected','previous_baseline_failure_resolved','previous_baseline_failure_still_present','not_comparable') and "candidate_verification_evidence"."repair_objective_evidence" = 'not_measured' and ("candidate_verification_evidence"."error_code" is null or "candidate_verification_evidence"."error_code" ~ '^[a-z_]{1,64}$') and "candidate_verification_evidence"."duration_ms" >= 0),
	CONSTRAINT "candidate_verification_evidence_contract_trust_check" CHECK ("candidate_verification_evidence"."verification_contract" = 'infrastructure_failed' or ("candidate_verification_evidence"."candidate_artifact_integrity" = 'valid' and "candidate_verification_evidence"."distinct_sandbox_confirmed" is true and "candidate_verification_evidence"."pristine_base_integrity" = 'valid' and "candidate_verification_evidence"."candidate_reconstruction" = 'valid' and "candidate_verification_evidence"."credentials_exposure" = 'absent' and "candidate_verification_evidence"."network_policy" = 'deny-all' and "candidate_verification_evidence"."install_status" = 'completed' and "candidate_verification_evidence"."install_exit_code" = 0 and "candidate_verification_evidence"."install_timed_out" is false and "candidate_verification_evidence"."reconstructed_source_identity" = "candidate_verification_evidence"."source_identity_after" and "candidate_verification_evidence"."source_integrity_unchanged" is true and "candidate_verification_evidence"."cleanup_stop" = 'confirmed' and "candidate_verification_evidence"."cleanup_delete" = 'confirmed' and "candidate_verification_evidence"."cleanup_lookup" = 'absent')),
	CONSTRAINT "candidate_verification_evidence_clean_success_check" CHECK ("candidate_verification_evidence"."verification_contract" <> 'checks_passed' or ("candidate_verification_evidence"."candidate_artifact_integrity" = 'valid' and "candidate_verification_evidence"."distinct_sandbox_confirmed" is true and "candidate_verification_evidence"."pristine_base_integrity" = 'valid' and "candidate_verification_evidence"."candidate_reconstruction" = 'valid' and "candidate_verification_evidence"."credentials_exposure" = 'absent' and "candidate_verification_evidence"."network_policy" = 'deny-all' and "candidate_verification_evidence"."install_status" = 'completed' and "candidate_verification_evidence"."install_exit_code" = 0 and "candidate_verification_evidence"."install_timed_out" is false and ("candidate_verification_evidence"."typecheck_status" is null or ("candidate_verification_evidence"."typecheck_status" = 'completed' and "candidate_verification_evidence"."typecheck_exit_code" = 0 and "candidate_verification_evidence"."typecheck_timed_out" is false)) and ("candidate_verification_evidence"."build_status" is null or ("candidate_verification_evidence"."build_status" = 'completed' and "candidate_verification_evidence"."build_exit_code" = 0 and "candidate_verification_evidence"."build_timed_out" is false)) and "candidate_verification_evidence"."test_status" = 'completed' and "candidate_verification_evidence"."test_exit_code" = 0 and "candidate_verification_evidence"."test_timed_out" is false and "candidate_verification_evidence"."reconstructed_source_identity" = "candidate_verification_evidence"."source_identity_after" and "candidate_verification_evidence"."source_integrity_unchanged" is true and "candidate_verification_evidence"."cleanup_stop" = 'confirmed' and "candidate_verification_evidence"."cleanup_delete" = 'confirmed' and "candidate_verification_evidence"."cleanup_lookup" = 'absent' and "candidate_verification_evidence"."error_code" is null))
);
--> statement-breakpoint
CREATE TABLE "candidate_verification_event" (
	"id" text PRIMARY KEY NOT NULL,
	"verification_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"verification_contract" text,
	"baseline_comparison" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_verification_event_state_check" CHECK (("candidate_verification_event"."from_state" is null or "candidate_verification_event"."from_state" in ('created','queued','verifying','completed','infrastructure_failed','cancelled')) and "candidate_verification_event"."to_state" in ('created','queued','verifying','completed','infrastructure_failed','cancelled')),
	CONSTRAINT "candidate_verification_event_transition_check" CHECK (("candidate_verification_event"."from_state" is null and "candidate_verification_event"."to_state" = 'created') or ("candidate_verification_event"."from_state" = 'created' and "candidate_verification_event"."to_state" in ('queued','cancelled')) or ("candidate_verification_event"."from_state" = 'queued' and "candidate_verification_event"."to_state" in ('verifying','cancelled')) or ("candidate_verification_event"."from_state" = 'verifying' and "candidate_verification_event"."to_state" in ('completed','infrastructure_failed','cancelled'))),
	CONSTRAINT "candidate_verification_event_safe_check" CHECK (("candidate_verification_event"."verification_contract" is null or "candidate_verification_event"."verification_contract" in ('checks_passed','checks_failed','infrastructure_failed')) and ("candidate_verification_event"."baseline_comparison" is null or "candidate_verification_event"."baseline_comparison" in ('no_regression_detected','regression_detected','previous_baseline_failure_resolved','previous_baseline_failure_still_present','not_comparable')) and ("candidate_verification_event"."failure_code" is null or "candidate_verification_event"."failure_code" ~ '^[a-z_]{1,64}$'))
);
--> statement-breakpoint
ALTER TABLE "candidate_verification" ADD CONSTRAINT "candidate_verification_candidate_id_repair_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."repair_candidate"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification" ADD CONSTRAINT "candidate_verification_investigation_id_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigation"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification" ADD CONSTRAINT "candidate_verification_repair_run_id_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "public"."repair_run"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification" ADD CONSTRAINT "candidate_verification_baseline_id_repository_baseline_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."repository_baseline"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification" ADD CONSTRAINT "candidate_verification_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification_attempt" ADD CONSTRAINT "candidate_verification_attempt_verification_id_candidate_verification_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."candidate_verification"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification_evidence" ADD CONSTRAINT "candidate_verification_evidence_verification_id_candidate_verification_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."candidate_verification"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification_evidence" ADD CONSTRAINT "candidate_verification_evidence_attempt_id_candidate_verification_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."candidate_verification_attempt"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification_evidence" ADD CONSTRAINT "candidate_verification_evidence_candidate_id_repair_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."repair_candidate"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification_evidence" ADD CONSTRAINT "candidate_verification_evidence_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification_evidence" ADD CONSTRAINT "candidate_verification_evidence_baseline_id_repository_baseline_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."repository_baseline"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification_event" ADD CONSTRAINT "candidate_verification_event_verification_id_candidate_verification_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."candidate_verification"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification_event" ADD CONSTRAINT "candidate_verification_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification" ADD CONSTRAINT "candidate_verification_evidence_id_candidate_verification_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."candidate_verification_evidence"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_verification_attempt" ADD CONSTRAINT "candidate_verification_attempt_evidence_id_candidate_verification_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."candidate_verification_evidence"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "candidate_verification_workspace_created_idx" ON "candidate_verification" ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "candidate_verification_state_idx" ON "candidate_verification" ("state","updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_verification_active_candidate_unique" ON "candidate_verification" ("candidate_id") WHERE "candidate_verification"."state" in ('created','queued','verifying');
--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_verification_attempt_number_unique" ON "candidate_verification_attempt" ("verification_id","attempt_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_verification_attempt_active_unique" ON "candidate_verification_attempt" ("verification_id") WHERE "candidate_verification_attempt"."state" = 'active';
--> statement-breakpoint
CREATE INDEX "candidate_verification_attempt_verification_idx" ON "candidate_verification_attempt" ("verification_id","claimed_at");
--> statement-breakpoint
CREATE INDEX "candidate_verification_evidence_verification_idx" ON "candidate_verification_evidence" ("verification_id","completed_at");
--> statement-breakpoint
CREATE INDEX "candidate_verification_event_verification_idx" ON "candidate_verification_event" ("verification_id","created_at");
--> statement-breakpoint
CREATE FUNCTION "guard_candidate_verification_update"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'candidate verifications are immutable'; END IF;
	IF OLD."state" IN ('completed','infrastructure_failed','cancelled') THEN RAISE EXCEPTION 'completed candidate verifications are immutable'; END IF;
	IF NOT ((OLD."state" = 'created' AND NEW."state" IN ('queued','cancelled')) OR (OLD."state" = 'queued' AND NEW."state" IN ('verifying','cancelled')) OR (OLD."state" = 'verifying' AND NEW."state" IN ('completed','infrastructure_failed','cancelled'))) THEN RAISE EXCEPTION 'invalid candidate verification transition'; END IF;
	IF ROW(OLD."candidate_id",OLD."investigation_id",OLD."repair_run_id",OLD."baseline_id",OLD."workspace_id",OLD."github_repository_id",OLD."installation_id",OLD."base_commit_sha",OLD."profile_identity",OLD."candidate_identity",OLD."format_version",OLD."repair_objective_evidence",OLD."created_at",OLD."queued_at") IS DISTINCT FROM ROW(NEW."candidate_id",NEW."investigation_id",NEW."repair_run_id",NEW."baseline_id",NEW."workspace_id",NEW."github_repository_id",NEW."installation_id",NEW."base_commit_sha",NEW."profile_identity",NEW."candidate_identity",NEW."format_version",NEW."repair_objective_evidence",NEW."created_at",NEW."queued_at") THEN RAISE EXCEPTION 'candidate verification authority is immutable'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "candidate_verification_update_guard" BEFORE UPDATE OR DELETE ON "candidate_verification" FOR EACH ROW EXECUTE FUNCTION "guard_candidate_verification_update"();
--> statement-breakpoint
CREATE FUNCTION "guard_candidate_verification_evidence_mutation"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'candidate verification evidence is immutable'; END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "candidate_verification_evidence_mutation_guard" BEFORE UPDATE OR DELETE ON "candidate_verification_evidence" FOR EACH ROW EXECUTE FUNCTION "guard_candidate_verification_evidence_mutation"();
--> statement-breakpoint
CREATE FUNCTION "guard_candidate_verification_event_mutation"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'candidate verification events are append-only'; END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "candidate_verification_event_mutation_guard" BEFORE UPDATE OR DELETE ON "candidate_verification_event" FOR EACH ROW EXECUTE FUNCTION "guard_candidate_verification_event_mutation"();
