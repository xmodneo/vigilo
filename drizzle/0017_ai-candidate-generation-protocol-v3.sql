ALTER TABLE "ai_candidate_generation" DROP CONSTRAINT "ai_candidate_generation_provider_check";--> statement-breakpoint
ALTER TABLE "ai_candidate_generation" ADD CONSTRAINT "ai_candidate_generation_provider_check" CHECK (char_length("provider_id") between 1 and 40 and char_length("model_id") between 1 and 80 and "protocol_version" in (1,2,3));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_ai_candidate_generation_update"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI candidate generations are durable'; END IF;
	IF OLD."state" IN ('frozen','abstained','failed','cancelled') THEN RAISE EXCEPTION 'terminal AI candidate generations are immutable'; END IF;
	IF OLD."state" IS DISTINCT FROM NEW."state" AND NOT ((OLD."state" = 'created' AND NEW."state" IN ('queued','cancelled')) OR (OLD."state" = 'queued' AND NEW."state" IN ('generating','cancelled')) OR (OLD."state" = 'generating' AND NEW."state" IN ('frozen','abstained','failed','cancelled'))) THEN RAISE EXCEPTION 'invalid AI candidate generation transition'; END IF;
	IF ROW(OLD."ai_investigation_id",OLD."execution_ordinal",OLD."investigation_id",OLD."repair_run_id",OLD."baseline_id",OLD."workspace_id",OLD."github_repository_id",OLD."installation_id",OLD."base_commit_sha",OLD."profile_identity",OLD."provider_id",OLD."model_id",OLD."protocol_version",OLD."idempotency_key",OLD."created_at") IS DISTINCT FROM ROW(NEW."ai_investigation_id",NEW."execution_ordinal",NEW."investigation_id",NEW."repair_run_id",NEW."baseline_id",NEW."workspace_id",NEW."github_repository_id",NEW."installation_id",NEW."base_commit_sha",NEW."profile_identity",NEW."provider_id",NEW."model_id",NEW."protocol_version",NEW."idempotency_key",NEW."created_at") THEN RAISE EXCEPTION 'AI candidate generation authority is immutable'; END IF;
	IF OLD."queued_at" IS DISTINCT FROM NEW."queued_at" AND NOT (OLD."state" = 'created' AND NEW."state" = 'queued' AND OLD."queued_at" IS NULL AND NEW."queued_at" IS NOT NULL) THEN RAISE EXCEPTION 'AI candidate generation queue time is immutable'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
