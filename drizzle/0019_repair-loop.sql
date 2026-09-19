ALTER TABLE "ai_candidate_generation" DROP CONSTRAINT "ai_candidate_generation_provider_check";--> statement-breakpoint
ALTER TABLE "ai_candidate_generation" ADD CONSTRAINT "ai_candidate_generation_provider_check" CHECK (char_length("provider_id") between 1 and 40 and char_length("model_id") between 1 and 80 and "protocol_version" in (1,2,3,4));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_ai_candidate_generation_update"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI candidate generations are durable'; END IF;
	IF OLD."state" IN ('frozen','abstained','failed','cancelled') THEN RAISE EXCEPTION 'terminal AI candidate generations are immutable'; END IF;
	IF OLD."state" IS DISTINCT FROM NEW."state" AND NOT ((OLD."state" = 'created' AND NEW."state" IN ('queued','cancelled')) OR (OLD."state" = 'queued' AND NEW."state" IN ('generating','cancelled')) OR (OLD."state" = 'generating' AND NEW."state" IN ('frozen','abstained','failed','cancelled'))) THEN RAISE EXCEPTION 'invalid AI candidate generation transition'; END IF;
	IF ROW(OLD."ai_investigation_id",OLD."execution_ordinal",OLD."investigation_id",OLD."repair_run_id",OLD."baseline_id",OLD."workspace_id",OLD."github_repository_id",OLD."installation_id",OLD."base_commit_sha",OLD."profile_identity",OLD."provider_id",OLD."model_id",OLD."protocol_version",OLD."idempotency_key",OLD."created_at") IS DISTINCT FROM ROW(NEW."ai_investigation_id",NEW."execution_ordinal",NEW."investigation_id",NEW."repair_run_id",NEW."baseline_id",NEW."workspace_id",NEW."github_repository_id",NEW."installation_id",NEW."base_commit_sha",NEW."profile_identity",NEW."provider_id",NEW."model_id",NEW."protocol_version",NEW."idempotency_key",NEW."created_at") THEN RAISE EXCEPTION 'AI candidate generation authority is immutable'; END IF;
	IF OLD."queued_at" IS DISTINCT FROM NEW."queued_at" AND NOT (OLD."state" = 'created' AND NEW."state" = 'queued' AND OLD."queued_at" IS NULL AND NEW."queued_at" IS NOT NULL) THEN RAISE EXCEPTION 'AI candidate generation queue time is immutable'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TABLE "repair_loop" (
	"id" text PRIMARY KEY NOT NULL,
	"repair_run_id" text NOT NULL UNIQUE,
	"workspace_id" text NOT NULL,
	"investigation_id" text NOT NULL,
	"ai_investigation_id" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"max_iterations" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text NOT NULL,
	"wake_job_id" text,
	"selected_candidate_id" text,
	"selected_verification_id" text,
	"selected_evidence_id" text,
	"failure_classification" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_loop_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "idempotency_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and ("wake_job_id" is null or "wake_job_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')),
	CONSTRAINT "repair_loop_protocol_check" CHECK ("protocol_version" = 1 and "max_iterations" = 2),
	CONSTRAINT "repair_loop_state_check" CHECK ("state" in ('queued','running','verified','abstained','review_required','failed','limit_reached')),
	CONSTRAINT "repair_loop_failure_check" CHECK (("failure_classification" is null or "failure_classification" in ('generation_failure','verification_failure','infrastructure_failure','integrity_failure','ownership_failure')) and ("failure_code" is null or "failure_code" ~ '^[a-z_]{1,64}$')),
	CONSTRAINT "repair_loop_terminal_facts_check" CHECK (("state" in ('queued','running') and "wake_job_id" is not null and "completed_at" is null and "selected_candidate_id" is null and "selected_verification_id" is null and "selected_evidence_id" is null and "failure_classification" is null and "failure_code" is null) or ("state" = 'verified' and "completed_at" is not null and "selected_candidate_id" is not null and "selected_verification_id" is not null and "selected_evidence_id" is not null and "failure_classification" is null and "failure_code" is null) or ("state" in ('abstained','review_required','limit_reached') and "completed_at" is not null and "selected_candidate_id" is null and "selected_verification_id" is null and "selected_evidence_id" is null and "failure_classification" is null and "failure_code" is null) or ("state" = 'failed' and "completed_at" is not null and "selected_candidate_id" is null and "selected_verification_id" is null and "selected_evidence_id" is null and "failure_classification" is not null and "failure_code" is not null))
);--> statement-breakpoint

CREATE TABLE "repair_loop_iteration" (
	"id" text PRIMARY KEY NOT NULL,
	"repair_loop_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"ai_candidate_generation_id" text NOT NULL UNIQUE,
	"candidate_verification_id" text UNIQUE,
	"previous_iteration_id" text UNIQUE,
	"objective_contract_version" text NOT NULL,
	"objective_contract_snapshot" jsonb NOT NULL,
	"objective_contract_hash" text NOT NULL,
	"objective_contract_bytes" integer NOT NULL,
	"feedback_version" integer,
	"feedback_snapshot" jsonb,
	"feedback_hash" text,
	"feedback_bytes" integer,
	"feedback_verification_id" text,
	"feedback_evidence_id" text,
	"objective_evidence" text,
	"objective_evidence_snapshot" jsonb,
	"objective_evidence_hash" text,
	"objective_evidence_bytes" integer,
	"decision" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "repair_loop_iteration_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_loop_iteration_ordinal_check" CHECK ("ordinal" between 1 and 2),
	CONSTRAINT "repair_loop_iteration_contract_check" CHECK ("objective_contract_version" = 'baseline_recovery_v1' and "objective_contract_hash" ~ '^[0-9a-f]{64}$' and "objective_contract_bytes" between 1 and 16384),
	CONSTRAINT "repair_loop_iteration_feedback_check" CHECK (("ordinal" = 1 and "previous_iteration_id" is null and "feedback_version" is null and "feedback_snapshot" is null and "feedback_hash" is null and "feedback_bytes" is null and "feedback_verification_id" is null and "feedback_evidence_id" is null) or ("ordinal" = 2 and "previous_iteration_id" is not null and "feedback_version" = 1 and "feedback_snapshot" is not null and "feedback_hash" ~ '^[0-9a-f]{64}$' and "feedback_bytes" between 1 and 16384 and "feedback_verification_id" is not null and "feedback_evidence_id" is not null)),
	CONSTRAINT "repair_loop_iteration_result_check" CHECK (("decision" is null and "objective_evidence" is null and "objective_evidence_snapshot" is null and "objective_evidence_hash" is null and "objective_evidence_bytes" is null and "failure_code" is null and "decided_at" is null) or ("decision" in ('abstained','generation_failed') and "candidate_verification_id" is null and "objective_evidence" is null and "objective_evidence_snapshot" is null and "objective_evidence_hash" is null and "objective_evidence_bytes" is null and "decided_at" is not null) or ("decision" in ('verified','repairable_failure','verification_non_repairable') and "candidate_verification_id" is not null and "objective_evidence" in ('satisfied','failed','not_measured') and "objective_evidence_snapshot" is not null and "objective_evidence_hash" ~ '^[0-9a-f]{64}$' and "objective_evidence_bytes" between 1 and 16384 and "decided_at" is not null) or ("decision" = 'infrastructure_failed' and "objective_evidence" = 'not_measured' and "objective_evidence_snapshot" is not null and "objective_evidence_hash" ~ '^[0-9a-f]{64}$' and "objective_evidence_bytes" between 1 and 16384 and "decided_at" is not null) or ("decision" = 'evidence_invalid' and "objective_evidence" = 'not_measured' and "objective_evidence_snapshot" is not null and "objective_evidence_hash" ~ '^[0-9a-f]{64}$' and "objective_evidence_bytes" between 1 and 16384 and "decided_at" is not null)),
	CONSTRAINT "repair_loop_iteration_failure_check" CHECK (("failure_code" is null or "failure_code" ~ '^[a-z_]{1,64}$') and (("decision" in ('generation_failed','infrastructure_failed','evidence_invalid') and "failure_code" is not null) or ("decision" not in ('generation_failed','infrastructure_failed','evidence_invalid') and "failure_code" is null)))
);--> statement-breakpoint

CREATE TABLE "repair_loop_event" (
	"id" text PRIMARY KEY NOT NULL,
	"repair_loop_id" text NOT NULL,
	"iteration_id" text,
	"from_state" text,
	"to_state" text NOT NULL,
	"event_type" text NOT NULL,
	"decision" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_loop_event_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_loop_event_state_check" CHECK (("from_state" is null or "from_state" in ('queued','running','verified','abstained','review_required','failed','limit_reached')) and "to_state" in ('queued','running','verified','abstained','review_required','failed','limit_reached')),
	CONSTRAINT "repair_loop_event_type_check" CHECK ("event_type" in ('created','started','iteration_created','verification_created','iteration_decided','completed','reconciled')),
	CONSTRAINT "repair_loop_event_safe_check" CHECK (("decision" is null or "decision" in ('verified','repairable_failure','abstained','generation_failed','verification_non_repairable','infrastructure_failed','evidence_invalid')) and ("failure_code" is null or "failure_code" ~ '^[a-z_]{1,64}$'))
);--> statement-breakpoint

ALTER TABLE "repair_loop" ADD CONSTRAINT "repair_loop_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "repair_run"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop" ADD CONSTRAINT "repair_loop_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop" ADD CONSTRAINT "repair_loop_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "investigation"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop" ADD CONSTRAINT "repair_loop_ai_investigation_id_fk" FOREIGN KEY ("ai_investigation_id") REFERENCES "ai_investigation"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop" ADD CONSTRAINT "repair_loop_selected_candidate_id_fk" FOREIGN KEY ("selected_candidate_id") REFERENCES "repair_candidate"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop" ADD CONSTRAINT "repair_loop_selected_verification_id_fk" FOREIGN KEY ("selected_verification_id") REFERENCES "candidate_verification"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop" ADD CONSTRAINT "repair_loop_selected_evidence_id_fk" FOREIGN KEY ("selected_evidence_id") REFERENCES "candidate_verification_evidence"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop_iteration" ADD CONSTRAINT "repair_loop_iteration_loop_id_fk" FOREIGN KEY ("repair_loop_id") REFERENCES "repair_loop"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop_iteration" ADD CONSTRAINT "repair_loop_iteration_generation_id_fk" FOREIGN KEY ("ai_candidate_generation_id") REFERENCES "ai_candidate_generation"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop_iteration" ADD CONSTRAINT "repair_loop_iteration_verification_id_fk" FOREIGN KEY ("candidate_verification_id") REFERENCES "candidate_verification"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop_iteration" ADD CONSTRAINT "repair_loop_iteration_previous_id_fk" FOREIGN KEY ("previous_iteration_id") REFERENCES "repair_loop_iteration"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop_iteration" ADD CONSTRAINT "repair_loop_iteration_feedback_verification_id_fk" FOREIGN KEY ("feedback_verification_id") REFERENCES "candidate_verification"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop_iteration" ADD CONSTRAINT "repair_loop_iteration_feedback_evidence_id_fk" FOREIGN KEY ("feedback_evidence_id") REFERENCES "candidate_verification_evidence"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop_event" ADD CONSTRAINT "repair_loop_event_loop_id_fk" FOREIGN KEY ("repair_loop_id") REFERENCES "repair_loop"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_loop_event" ADD CONSTRAINT "repair_loop_event_iteration_id_fk" FOREIGN KEY ("iteration_id") REFERENCES "repair_loop_iteration"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "repair_loop_workspace_idempotency_unique" ON "repair_loop" ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "repair_loop_workspace_created_idx" ON "repair_loop" ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "repair_loop_state_updated_idx" ON "repair_loop" ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repair_loop_iteration_ordinal_unique" ON "repair_loop_iteration" ("repair_loop_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "repair_loop_iteration_undecided_unique" ON "repair_loop_iteration" ("repair_loop_id") WHERE "decision" is null;--> statement-breakpoint
CREATE INDEX "repair_loop_iteration_loop_created_idx" ON "repair_loop_iteration" ("repair_loop_id","created_at");--> statement-breakpoint
CREATE INDEX "repair_loop_event_loop_created_idx" ON "repair_loop_event" ("repair_loop_id","created_at");--> statement-breakpoint

CREATE FUNCTION "guard_repair_loop_insert"() RETURNS trigger AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "repair_run" r
		JOIN "investigation" i ON i."id" = NEW."investigation_id" AND i."repair_run_id" = r."id"
		JOIN "ai_investigation" a ON a."id" = NEW."ai_investigation_id" AND a."investigation_id" = i."id" AND a."repair_run_id" = r."id"
		WHERE r."id" = NEW."repair_run_id" AND r."state" = 'ready_for_investigation' AND i."state" = 'ready'
		AND a."state" = 'completed' AND a."conclusion_status" = 'diagnosis_found'
		AND r."workspace_id" = NEW."workspace_id" AND i."workspace_id" = NEW."workspace_id" AND a."workspace_id" = NEW."workspace_id"
		AND ROW(r."github_repository_id",r."installation_id",r."base_commit_sha",r."profile_identity",r."baseline_id") = ROW(i."github_repository_id",i."installation_id",i."base_commit_sha",i."profile_identity",i."baseline_id")
		AND ROW(r."github_repository_id",r."installation_id",r."base_commit_sha",r."profile_identity",r."baseline_id") = ROW(a."github_repository_id",a."installation_id",a."base_commit_sha",a."profile_identity",a."baseline_id")
	) THEN RAISE EXCEPTION 'repair loop authority mismatch'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_loop_insert_guard" BEFORE INSERT ON "repair_loop" FOR EACH ROW EXECUTE FUNCTION "guard_repair_loop_insert"();--> statement-breakpoint

CREATE FUNCTION "guard_repair_loop_update"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'repair loops are durable'; END IF;
	IF OLD."state" IN ('verified','abstained','review_required','failed','limit_reached') THEN RAISE EXCEPTION 'terminal repair loops are immutable'; END IF;
	IF ROW(OLD."repair_run_id",OLD."workspace_id",OLD."investigation_id",OLD."ai_investigation_id",OLD."protocol_version",OLD."max_iterations",OLD."idempotency_key",OLD."created_at") IS DISTINCT FROM ROW(NEW."repair_run_id",NEW."workspace_id",NEW."investigation_id",NEW."ai_investigation_id",NEW."protocol_version",NEW."max_iterations",NEW."idempotency_key",NEW."created_at") THEN RAISE EXCEPTION 'repair loop authority is immutable'; END IF;
	IF OLD."state" IS DISTINCT FROM NEW."state" AND NOT ((OLD."state" = 'queued' AND NEW."state" IN ('running','failed')) OR (OLD."state" = 'running' AND NEW."state" IN ('verified','abstained','review_required','failed','limit_reached'))) THEN RAISE EXCEPTION 'invalid repair loop transition'; END IF;
	IF (OLD."selected_candidate_id" IS NOT NULL OR OLD."selected_verification_id" IS NOT NULL OR OLD."selected_evidence_id" IS NOT NULL) AND ROW(OLD."selected_candidate_id",OLD."selected_verification_id",OLD."selected_evidence_id") IS DISTINCT FROM ROW(NEW."selected_candidate_id",NEW."selected_verification_id",NEW."selected_evidence_id") THEN RAISE EXCEPTION 'repair loop selection is immutable'; END IF;
	IF OLD."started_at" IS DISTINCT FROM NEW."started_at" AND NOT (OLD."state" = 'queued' AND NEW."state" = 'running' AND OLD."started_at" IS NULL AND NEW."started_at" IS NOT NULL) THEN RAISE EXCEPTION 'repair loop start time is immutable'; END IF;
	IF OLD."completed_at" IS DISTINCT FROM NEW."completed_at" AND NOT (OLD."completed_at" IS NULL AND NEW."completed_at" IS NOT NULL AND NEW."state" IN ('verified','abstained','review_required','failed','limit_reached')) THEN RAISE EXCEPTION 'repair loop completion time is immutable'; END IF;
	IF NEW."state" = 'verified' AND NOT EXISTS (
		SELECT 1 FROM "repair_loop_iteration" i
		JOIN "ai_candidate_generation" g ON g."id" = i."ai_candidate_generation_id"
		JOIN "candidate_verification" v ON v."id" = i."candidate_verification_id"
		JOIN "candidate_verification_evidence" e ON e."id" = v."evidence_id"
		WHERE i."repair_loop_id" = NEW."id" AND i."decision" = 'verified' AND i."objective_evidence" = 'satisfied'
		AND g."repair_candidate_id" = NEW."selected_candidate_id" AND v."id" = NEW."selected_verification_id" AND e."id" = NEW."selected_evidence_id"
		AND v."candidate_id" = g."repair_candidate_id" AND e."verification_id" = v."id" AND e."candidate_id" = v."candidate_id" AND e."candidate_identity" = v."candidate_identity"
	) THEN RAISE EXCEPTION 'repair loop selection provenance mismatch'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_loop_update_guard" BEFORE UPDATE OR DELETE ON "repair_loop" FOR EACH ROW EXECUTE FUNCTION "guard_repair_loop_update"();--> statement-breakpoint

CREATE FUNCTION "guard_repair_loop_iteration_update"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'repair loop iterations are durable'; END IF;
	IF TG_OP = 'INSERT' THEN
		IF NOT EXISTS (
			SELECT 1 FROM "repair_loop" l JOIN "ai_candidate_generation" g ON g."id" = NEW."ai_candidate_generation_id"
			WHERE l."id" = NEW."repair_loop_id" AND l."state" IN ('queued','running') AND g."protocol_version" = 4
			AND g."repair_run_id" = l."repair_run_id" AND g."investigation_id" = l."investigation_id" AND g."ai_investigation_id" = l."ai_investigation_id" AND g."workspace_id" = l."workspace_id"
		) THEN RAISE EXCEPTION 'repair loop iteration generation authority mismatch'; END IF;
		IF NEW."ordinal" = 2 AND NOT EXISTS (
			SELECT 1 FROM "repair_loop_iteration" p JOIN "candidate_verification" v ON v."id" = p."candidate_verification_id" JOIN "candidate_verification_evidence" e ON e."id" = v."evidence_id"
			WHERE p."id" = NEW."previous_iteration_id" AND p."repair_loop_id" = NEW."repair_loop_id" AND p."ordinal" = 1 AND p."decision" = 'repairable_failure'
			AND v."id" = NEW."feedback_verification_id" AND e."id" = NEW."feedback_evidence_id"
			AND p."objective_contract_version" = NEW."objective_contract_version" AND p."objective_contract_hash" = NEW."objective_contract_hash" AND p."objective_contract_bytes" = NEW."objective_contract_bytes"
		) THEN RAISE EXCEPTION 'repair loop feedback provenance mismatch'; END IF;
		RETURN NEW;
	END IF;
	IF OLD."decision" IS NOT NULL THEN RAISE EXCEPTION 'decided repair loop iterations are immutable'; END IF;
	IF ROW(OLD."repair_loop_id",OLD."ordinal",OLD."ai_candidate_generation_id",OLD."previous_iteration_id",OLD."objective_contract_version",OLD."objective_contract_snapshot",OLD."objective_contract_hash",OLD."objective_contract_bytes",OLD."feedback_version",OLD."feedback_snapshot",OLD."feedback_hash",OLD."feedback_bytes",OLD."feedback_verification_id",OLD."feedback_evidence_id",OLD."created_at") IS DISTINCT FROM ROW(NEW."repair_loop_id",NEW."ordinal",NEW."ai_candidate_generation_id",NEW."previous_iteration_id",NEW."objective_contract_version",NEW."objective_contract_snapshot",NEW."objective_contract_hash",NEW."objective_contract_bytes",NEW."feedback_version",NEW."feedback_snapshot",NEW."feedback_hash",NEW."feedback_bytes",NEW."feedback_verification_id",NEW."feedback_evidence_id",NEW."created_at") THEN RAISE EXCEPTION 'repair loop iteration authority is immutable'; END IF;
	IF OLD."candidate_verification_id" IS DISTINCT FROM NEW."candidate_verification_id" AND NOT (OLD."candidate_verification_id" IS NULL AND NEW."candidate_verification_id" IS NOT NULL) THEN RAISE EXCEPTION 'repair loop verification binding is immutable'; END IF;
	IF OLD."candidate_verification_id" IS NULL AND NEW."candidate_verification_id" IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM "ai_candidate_generation" g JOIN "candidate_verification" v ON v."id" = NEW."candidate_verification_id"
		WHERE g."id" = NEW."ai_candidate_generation_id" AND g."state" = 'frozen' AND g."repair_candidate_id" = v."candidate_id"
		AND g."investigation_id" = v."investigation_id" AND g."repair_run_id" = v."repair_run_id" AND g."baseline_id" = v."baseline_id" AND g."workspace_id" = v."workspace_id" AND g."base_commit_sha" = v."base_commit_sha" AND g."profile_identity" = v."profile_identity"
	) THEN RAISE EXCEPTION 'repair loop verification provenance mismatch'; END IF;
	IF OLD."decision" IS NULL AND NEW."decision" = 'verified' AND NOT (NEW."objective_evidence" = 'satisfied' AND EXISTS (SELECT 1 FROM "candidate_verification" v WHERE v."id" = NEW."candidate_verification_id" AND v."state" = 'completed' AND v."evidence_id" IS NOT NULL AND v."baseline_comparison" <> 'regression_detected')) THEN RAISE EXCEPTION 'repair loop verified decision lacks evidence'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_loop_iteration_update_guard" BEFORE INSERT OR UPDATE OR DELETE ON "repair_loop_iteration" FOR EACH ROW EXECUTE FUNCTION "guard_repair_loop_iteration_update"();--> statement-breakpoint

CREATE FUNCTION "guard_repair_loop_event_insert"() RETURNS trigger AS $$
BEGIN
	IF NEW."iteration_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "repair_loop_iteration" i WHERE i."id" = NEW."iteration_id" AND i."repair_loop_id" = NEW."repair_loop_id") THEN RAISE EXCEPTION 'repair loop event iteration mismatch'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_loop_event_insert_guard" BEFORE INSERT ON "repair_loop_event" FOR EACH ROW EXECUTE FUNCTION "guard_repair_loop_event_insert"();--> statement-breakpoint

CREATE FUNCTION "guard_repair_loop_event_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'repair loop events are append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_loop_event_mutation_guard" BEFORE UPDATE OR DELETE ON "repair_loop_event" FOR EACH ROW EXECUTE FUNCTION "guard_repair_loop_event_mutation"();
