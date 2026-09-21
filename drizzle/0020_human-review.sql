CREATE TABLE "human_review_decision" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"workspace_id" text NOT NULL,
	"reviewer_user_id" text NOT NULL,
	"repair_run_id" text NOT NULL,
	"repair_loop_id" text NOT NULL,
	"repair_loop_iteration_id" text NOT NULL,
	"ai_candidate_generation_id" text NOT NULL,
	"repair_candidate_id" text NOT NULL,
	"candidate_identity" text NOT NULL,
	"candidate_verification_id" text NOT NULL,
	"verification_evidence_id" text NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"baseline_id" text NOT NULL,
	"base_commit_sha" text NOT NULL,
	"profile_identity" text NOT NULL,
	"objective_contract_hash" text NOT NULL,
	"objective_evidence_hash" text NOT NULL,
	"verification_evidence_identity" text NOT NULL,
	"review_subject_identity" text NOT NULL,
	"decision" text NOT NULL,
	"decision_identity" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "human_review_decision_repair_loop_id_unique" UNIQUE("repair_loop_id"),
	CONSTRAINT "human_review_decision_identity_unique" UNIQUE("decision_identity"),
	CONSTRAINT "human_review_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "idempotency_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "human_review_version_check" CHECK ("version" = 1),
	CONSTRAINT "human_review_decision_check" CHECK ("decision" in ('approved','rejected')),
	CONSTRAINT "human_review_commit_check" CHECK ("base_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "human_review_hashes_check" CHECK ("candidate_identity" ~ '^[0-9a-f]{64}$' and "profile_identity" ~ '^[0-9a-f]{64}$' and "objective_contract_hash" ~ '^[0-9a-f]{64}$' and "objective_evidence_hash" ~ '^[0-9a-f]{64}$' and "verification_evidence_identity" ~ '^[0-9a-f]{64}$' and "review_subject_identity" ~ '^[0-9a-f]{64}$' and "decision_identity" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint

ALTER TABLE "human_review_decision" ADD CONSTRAINT "human_review_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "human_review_decision" ADD CONSTRAINT "human_review_reviewer_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "human_review_decision" ADD CONSTRAINT "human_review_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "repair_run"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "human_review_decision" ADD CONSTRAINT "human_review_repair_loop_id_fk" FOREIGN KEY ("repair_loop_id") REFERENCES "repair_loop"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "human_review_decision" ADD CONSTRAINT "human_review_iteration_id_fk" FOREIGN KEY ("repair_loop_iteration_id") REFERENCES "repair_loop_iteration"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "human_review_decision" ADD CONSTRAINT "human_review_generation_id_fk" FOREIGN KEY ("ai_candidate_generation_id") REFERENCES "ai_candidate_generation"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "human_review_decision" ADD CONSTRAINT "human_review_candidate_id_fk" FOREIGN KEY ("repair_candidate_id") REFERENCES "repair_candidate"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "human_review_decision" ADD CONSTRAINT "human_review_verification_id_fk" FOREIGN KEY ("candidate_verification_id") REFERENCES "candidate_verification"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "human_review_decision" ADD CONSTRAINT "human_review_evidence_id_fk" FOREIGN KEY ("verification_evidence_id") REFERENCES "candidate_verification_evidence"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "human_review_decision" ADD CONSTRAINT "human_review_baseline_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "repository_baseline"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "human_review_workspace_idempotency_unique" ON "human_review_decision" ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "human_review_workspace_created_idx" ON "human_review_decision" ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "human_review_repair_run_idx" ON "human_review_decision" ("repair_run_id","created_at");--> statement-breakpoint

CREATE FUNCTION "guard_human_review_decision_insert"() RETURNS trigger AS $$
BEGIN
	PERFORM 1 FROM "repair_run" r WHERE r."id" = NEW."repair_run_id" FOR UPDATE;
	IF NOT FOUND THEN RAISE EXCEPTION 'human review repair run not found'; END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM "workspace" w
		JOIN "repair_run" r ON r."workspace_id" = w."id"
		JOIN "repository_baseline" b ON b."id" = r."baseline_id"
		JOIN "execution_profile" p ON p."github_repository_id" = r."github_repository_id" AND p."workspace_id" = w."id"
		JOIN "repair_loop" l ON l."repair_run_id" = r."id" AND l."workspace_id" = w."id"
		JOIN "repair_loop_iteration" i ON i."repair_loop_id" = l."id"
		JOIN "ai_candidate_generation" g ON g."id" = i."ai_candidate_generation_id"
		JOIN "repair_candidate" c ON c."id" = g."repair_candidate_id"
		JOIN "candidate_verification" v ON v."id" = i."candidate_verification_id"
		JOIN "candidate_verification_evidence" e ON e."id" = v."evidence_id"
		JOIN "candidate_verification_attempt" a ON a."id" = e."attempt_id"
		WHERE w."id" = NEW."workspace_id" AND w."owner_user_id" = NEW."reviewer_user_id"
		AND r."id" = NEW."repair_run_id"
		AND l."id" = NEW."repair_loop_id" AND l."state" = 'verified'
		AND l."selected_candidate_id" = NEW."repair_candidate_id"
		AND l."selected_verification_id" = NEW."candidate_verification_id"
		AND l."selected_evidence_id" = NEW."verification_evidence_id"
		AND i."id" = NEW."repair_loop_iteration_id" AND i."decision" = 'verified'
		AND NOT EXISTS (SELECT 1 FROM "repair_loop_iteration" other_i WHERE other_i."repair_loop_id" = l."id" AND other_i."candidate_verification_id" = v."id" AND other_i."id" <> i."id")
		AND i."objective_evidence" = 'satisfied' AND i."objective_contract_version" = 'baseline_recovery_v1'
		AND (i."objective_contract_snapshot"->>'measurable')::boolean IS TRUE
		AND i."objective_contract_hash" = NEW."objective_contract_hash"
		AND i."objective_evidence_hash" = NEW."objective_evidence_hash"
		AND p."installation_id" = NEW."installation_id" AND p."base_commit_sha" = NEW."base_commit_sha"
		AND p."profile_identity" = NEW."profile_identity" AND p."status" = 'ready' AND p."test_script" = 'test'
		AND b."evidence_version" = 1 AND b."overall_outcome" IN ('baseline_failed','typecheck_failed','build_failed','test_failed')
		AND b."execution_outcome" = b."overall_outcome" AND b."credentials_exposure" = 'absent' AND b."network_policy" = 'deny-all'
		AND b."install_status" = 'completed' AND b."install_exit_code" = 0 AND b."install_timed_out" IS FALSE
		AND b."cleanup_stop" = 'confirmed' AND b."cleanup_delete" = 'confirmed' AND b."cleanup_lookup" = 'absent'
		AND ((p."typecheck_script" = 'typecheck' AND b."typecheck_status" = 'failed' AND b."typecheck_exit_code" <> 0 AND b."typecheck_timed_out" IS FALSE)
			OR (p."build_script" = 'build' AND b."build_status" = 'failed' AND b."build_exit_code" <> 0 AND b."build_timed_out" IS FALSE)
			OR (b."test_status" = 'failed' AND b."test_exit_code" <> 0 AND b."test_timed_out" IS FALSE))
		AND g."id" = NEW."ai_candidate_generation_id" AND g."state" = 'frozen' AND g."protocol_version" = 4
		AND c."id" = NEW."repair_candidate_id" AND c."state" = 'frozen' AND c."candidate_identity" = NEW."candidate_identity"
		AND v."id" = NEW."candidate_verification_id" AND v."candidate_id" = c."id" AND v."candidate_identity" = c."candidate_identity"
		AND v."state" = 'completed' AND v."candidate_artifact_integrity" = 'valid' AND v."verification_contract" = 'checks_passed'
		AND v."baseline_comparison" = 'previous_baseline_failure_resolved' AND v."evidence_id" = NEW."verification_evidence_id"
		AND e."id" = NEW."verification_evidence_id" AND e."verification_id" = v."id" AND e."candidate_id" = c."id"
		AND a."verification_id" = v."id" AND a."expected_evidence_id" = e."id"
		AND a."evidence_id" = e."id" AND a."state" = 'succeeded'
		AND e."candidate_identity" = c."candidate_identity" AND e."candidate_artifact_integrity" = 'valid'
		AND e."verification_contract" = 'checks_passed' AND e."execution_outcome" = 'checks_passed'
		AND e."baseline_comparison" = 'previous_baseline_failure_resolved' AND e."distinct_sandbox_confirmed" IS TRUE
		AND e."pristine_base_integrity" = 'valid' AND e."candidate_reconstruction" = 'valid'
		AND e."pristine_source_identity" IS NOT NULL
		AND e."pristine_source_identity" IS NOT DISTINCT FROM b."source_identity_before"
		AND e."credentials_exposure" = 'absent' AND e."network_policy" = 'deny-all'
		AND e."source_integrity_unchanged" IS TRUE AND e."reconstructed_source_identity" IS NOT NULL
		AND e."reconstructed_source_identity" IS NOT DISTINCT FROM e."source_identity_after"
		AND e."cleanup_stop" = 'confirmed' AND e."cleanup_delete" = 'confirmed' AND e."cleanup_lookup" = 'absent'
		AND ROW(r."github_repository_id",r."installation_id",r."baseline_id",r."base_commit_sha",r."profile_identity")
			IS NOT DISTINCT FROM ROW(NEW."github_repository_id",NEW."installation_id",NEW."baseline_id",NEW."base_commit_sha",NEW."profile_identity")
		AND ROW(b."workspace_id",b."github_repository_id",b."installation_id",b."base_commit_sha",b."profile_identity",b."source_identity_before",b."source_identity_after",b."source_unchanged")
			IS NOT DISTINCT FROM ROW(w."id",NEW."github_repository_id",NEW."installation_id",NEW."base_commit_sha",NEW."profile_identity",e."pristine_source_identity",e."pristine_source_identity",TRUE)
		AND ROW(g."repair_run_id",g."workspace_id",g."github_repository_id",g."installation_id",g."baseline_id",g."base_commit_sha",g."profile_identity")
			IS NOT DISTINCT FROM ROW(r."id",w."id",NEW."github_repository_id",NEW."installation_id",NEW."baseline_id",NEW."base_commit_sha",NEW."profile_identity")
		AND ROW(c."repair_run_id",c."workspace_id",c."github_repository_id",c."installation_id",c."base_commit_sha",c."profile_identity")
			IS NOT DISTINCT FROM ROW(r."id",w."id",NEW."github_repository_id",NEW."installation_id",NEW."base_commit_sha",NEW."profile_identity")
		AND ROW(v."repair_run_id",v."workspace_id",v."github_repository_id",v."installation_id",v."baseline_id",v."base_commit_sha",v."profile_identity")
			IS NOT DISTINCT FROM ROW(r."id",w."id",NEW."github_repository_id",NEW."installation_id",NEW."baseline_id",NEW."base_commit_sha",NEW."profile_identity")
		AND ROW(e."workspace_id",e."github_repository_id",e."installation_id",e."baseline_id",e."base_commit_sha",e."profile_identity")
			IS NOT DISTINCT FROM ROW(w."id",NEW."github_repository_id",NEW."installation_id",NEW."baseline_id",NEW."base_commit_sha",NEW."profile_identity")
	) THEN RAISE EXCEPTION 'human review authority mismatch'; END IF;
	IF EXISTS (
		SELECT 1 FROM "ai_candidate_generation" other
		WHERE other."repair_run_id" = NEW."repair_run_id"
		AND other."state" IN ('created','queued','generating')
	) OR EXISTS (
		SELECT 1 FROM "repair_candidate" other
		WHERE other."repair_run_id" = NEW."repair_run_id"
		AND other."state" = 'freezing'
	) OR EXISTS (
		SELECT 1 FROM "candidate_verification" other
		WHERE other."repair_run_id" = NEW."repair_run_id"
		AND other."id" <> NEW."candidate_verification_id"
		AND other."state" IN ('created','queued','verifying')
	) THEN RAISE EXCEPTION 'human review evidence is ambiguous'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "human_review_decision_insert_guard" BEFORE INSERT ON "human_review_decision" FOR EACH ROW EXECUTE FUNCTION "guard_human_review_decision_insert"();--> statement-breakpoint

CREATE FUNCTION "guard_human_review_decision_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'human review decisions are immutable';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "human_review_decision_mutation_guard" BEFORE UPDATE OR DELETE ON "human_review_decision" FOR EACH ROW EXECUTE FUNCTION "guard_human_review_decision_mutation"();--> statement-breakpoint

CREATE FUNCTION "guard_reviewed_repair_run_child_write"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		PERFORM 1 FROM "repair_run" r WHERE r."id" IN (OLD."repair_run_id", NEW."repair_run_id") ORDER BY r."id" FOR UPDATE;
	ELSE
		PERFORM 1 FROM "repair_run" r WHERE r."id" = NEW."repair_run_id" FOR UPDATE;
	END IF;
	IF EXISTS (
		SELECT 1 FROM "human_review_decision" d
		WHERE d."repair_run_id" = NEW."repair_run_id" OR (TG_OP = 'UPDATE' AND d."repair_run_id" = OLD."repair_run_id")
	) THEN
		RAISE EXCEPTION 'reviewed repair run is closed';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "human_review_generation_write_guard" BEFORE INSERT OR UPDATE ON "ai_candidate_generation" FOR EACH ROW EXECUTE FUNCTION "guard_reviewed_repair_run_child_write"();--> statement-breakpoint
CREATE TRIGGER "human_review_candidate_write_guard" BEFORE INSERT OR UPDATE ON "repair_candidate" FOR EACH ROW EXECUTE FUNCTION "guard_reviewed_repair_run_child_write"();--> statement-breakpoint
CREATE TRIGGER "human_review_verification_write_guard" BEFORE INSERT OR UPDATE ON "candidate_verification" FOR EACH ROW EXECUTE FUNCTION "guard_reviewed_repair_run_child_write"();--> statement-breakpoint

CREATE FUNCTION "guard_reviewed_candidate_file_insert"() RETURNS trigger AS $$
DECLARE run_id text;
BEGIN
	SELECT c."repair_run_id" INTO run_id FROM "repair_candidate" c WHERE c."id" = NEW."candidate_id";
	IF run_id IS NULL THEN RAISE EXCEPTION 'repair candidate not found'; END IF;
	PERFORM 1 FROM "repair_run" r WHERE r."id" = run_id FOR UPDATE;
	IF EXISTS (SELECT 1 FROM "human_review_decision" d WHERE d."repair_run_id" = run_id) THEN
		RAISE EXCEPTION 'reviewed repair run is closed';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "human_review_candidate_file_insert_guard" BEFORE INSERT ON "repair_candidate_file" FOR EACH ROW EXECUTE FUNCTION "guard_reviewed_candidate_file_insert"();
