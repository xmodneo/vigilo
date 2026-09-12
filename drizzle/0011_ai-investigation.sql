CREATE TABLE "ai_investigation" (
	"id" text PRIMARY KEY NOT NULL,
	"investigation_id" text NOT NULL UNIQUE,
	"repair_run_id" text NOT NULL,
	"baseline_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"base_commit_sha" text NOT NULL,
	"profile_identity" text NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"state" text NOT NULL,
	"completion_reason" text,
	"conclusion_status" text,
	"summary" text,
	"suspected_files" jsonb,
	"evidence_references" jsonb,
	"proposed_approach" text,
	"confidence" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"model_turn_count" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"investigation_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_investigation_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "ai_investigation_commit_check" CHECK ("base_commit_sha" ~ '^[0-9a-f]{40}$' and "profile_identity" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_investigation_provider_check" CHECK (char_length("provider_id") between 1 and 40 and char_length("model_id") between 1 and 80 and "protocol_version" = 1),
	CONSTRAINT "ai_investigation_state_check" CHECK ("state" in ('created','queued','investigating','completed','failed','cancelled')),
	CONSTRAINT "ai_investigation_completion_check" CHECK (("completion_reason" is null or "completion_reason" in ('model_conclusion','budget_exhausted')) and ("conclusion_status" is null or "conclusion_status" in ('diagnosis_found','insufficient_evidence','objective_not_reproduced')) and ("confidence" is null or "confidence" in ('low','medium','high'))),
	CONSTRAINT "ai_investigation_usage_check" CHECK ("input_tokens" between 0 and 1000000 and "output_tokens" between 0 and 100000 and "tool_call_count" between 0 and 20 and "model_turn_count" between 0 and 8),
	CONSTRAINT "ai_investigation_output_check" CHECK (("summary" is null or char_length("summary") between 1 and 1200) and ("proposed_approach" is null or char_length("proposed_approach") between 1 and 1600) and ("suspected_files" is null or (jsonb_typeof("suspected_files") = 'array' and jsonb_array_length("suspected_files") <= 8)) and ("evidence_references" is null or (jsonb_typeof("evidence_references") = 'array' and jsonb_array_length("evidence_references") <= 12)) and ("failure_code" is null or "failure_code" ~ '^[a-z_]{1,64}$')),
	CONSTRAINT "ai_investigation_evidence_check" CHECK ("completion_reason" <> 'model_conclusion' or (jsonb_typeof("evidence_references") = 'array' and jsonb_array_length("evidence_references") between 1 and 12 and ("conclusion_status" <> 'diagnosis_found' or jsonb_array_length("suspected_files") between 1 and 8))),
	CONSTRAINT "ai_investigation_state_facts_check" CHECK (("state" = 'created' and "queued_at" is null and "investigation_started_at" is null and "completed_at" is null and "conclusion_status" is null and "failure_code" is null) or ("state" = 'queued' and "queued_at" is not null and "investigation_started_at" is null and "completed_at" is null and "conclusion_status" is null and "failure_code" is null) or ("state" = 'investigating' and "queued_at" is not null and "investigation_started_at" is not null and "completed_at" is null and "conclusion_status" is null) or ("state" = 'completed' and "queued_at" is not null and "investigation_started_at" is not null and "completed_at" is not null and "completion_reason" is not null and "conclusion_status" is not null and "summary" is not null and "suspected_files" is not null and "evidence_references" is not null and "proposed_approach" is not null and "confidence" is not null and "failure_code" is null) or ("state" in ('failed','cancelled') and "queued_at" is not null and "completed_at" is not null and "failure_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "ai_investigation_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"ai_investigation_id" text NOT NULL,
	"queue_job_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"ownership_token" text NOT NULL,
	"state" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"failure_code" text,
	CONSTRAINT "ai_investigation_attempt_number_unique" UNIQUE("ai_investigation_id","attempt_number"),
	CONSTRAINT "ai_investigation_attempt_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "queue_job_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "ownership_token" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "ai_investigation_attempt_number_check" CHECK ("attempt_number" between 1 and 3),
	CONSTRAINT "ai_investigation_attempt_state_check" CHECK ("state" in ('active','succeeded','retryable_failed','exhausted','abandoned')),
	CONSTRAINT "ai_investigation_attempt_lease_check" CHECK (("state" = 'active' and "lease_expires_at" is not null and "finished_at" is null) or ("state" <> 'active' and "lease_expires_at" is null and "finished_at" is not null)),
	CONSTRAINT "ai_investigation_attempt_failure_check" CHECK (("failure_code" is null or "failure_code" ~ '^[a-z_]{1,64}$') and (("state" = 'succeeded' and "failure_code" is null) or ("state" <> 'succeeded')))
);
--> statement-breakpoint
CREATE TABLE "ai_investigation_event" (
	"id" text PRIMARY KEY NOT NULL,
	"ai_investigation_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_investigation_event_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "ai_investigation_event_state_check" CHECK (("from_state" is null or "from_state" in ('created','queued','investigating','completed','failed','cancelled')) and "to_state" in ('created','queued','investigating','completed','failed','cancelled')),
	CONSTRAINT "ai_investigation_event_transition_check" CHECK (("from_state" is null and "to_state" = 'created') or ("from_state" = 'created' and "to_state" in ('queued','cancelled')) or ("from_state" = 'queued' and "to_state" in ('investigating','cancelled')) or ("from_state" = 'investigating' and "to_state" in ('completed','failed','cancelled'))),
	CONSTRAINT "ai_investigation_event_failure_check" CHECK (("failure_code" is null or "failure_code" ~ '^[a-z_]{1,64}$') and (("to_state" in ('failed','cancelled') and "failure_code" is not null) or ("to_state" not in ('failed','cancelled') and "failure_code" is null)))
);
--> statement-breakpoint
ALTER TABLE "ai_investigation" ADD CONSTRAINT "ai_investigation_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigation"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai_investigation" ADD CONSTRAINT "ai_investigation_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "public"."repair_run"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai_investigation" ADD CONSTRAINT "ai_investigation_baseline_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."repository_baseline"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai_investigation" ADD CONSTRAINT "ai_investigation_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai_investigation_attempt" ADD CONSTRAINT "ai_investigation_attempt_ai_id_fk" FOREIGN KEY ("ai_investigation_id") REFERENCES "public"."ai_investigation"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai_investigation_event" ADD CONSTRAINT "ai_investigation_event_ai_id_fk" FOREIGN KEY ("ai_investigation_id") REFERENCES "public"."ai_investigation"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai_investigation_event" ADD CONSTRAINT "ai_investigation_event_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "investigation_context_event" ADD COLUMN "ai_investigation_id" text;--> statement-breakpoint
ALTER TABLE "investigation_context_event" ADD CONSTRAINT "investigation_context_event_ai_id_fk" FOREIGN KEY ("ai_investigation_id") REFERENCES "public"."ai_investigation"("id") ON DELETE restrict;--> statement-breakpoint
CREATE INDEX "ai_investigation_workspace_created_idx" ON "ai_investigation" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_investigation_state_idx" ON "ai_investigation" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_investigation_attempt_active_unique" ON "ai_investigation_attempt" USING btree ("ai_investigation_id") WHERE "state" = 'active';--> statement-breakpoint
CREATE INDEX "ai_investigation_event_idx" ON "ai_investigation_event" USING btree ("ai_investigation_id","created_at");--> statement-breakpoint
CREATE INDEX "investigation_context_event_ai_idx" ON "investigation_context_event" USING btree ("ai_investigation_id","created_at");
--> statement-breakpoint
CREATE FUNCTION "guard_ai_investigation_update"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI investigations are durable'; END IF;
	IF OLD."state" IN ('completed','failed','cancelled') THEN RAISE EXCEPTION 'completed AI investigations are immutable'; END IF;
	IF OLD."state" IS DISTINCT FROM NEW."state" AND NOT ((OLD."state" = 'created' AND NEW."state" IN ('queued','cancelled')) OR (OLD."state" = 'queued' AND NEW."state" IN ('investigating','cancelled')) OR (OLD."state" = 'investigating' AND NEW."state" IN ('completed','failed','cancelled'))) THEN RAISE EXCEPTION 'invalid AI investigation transition'; END IF;
	IF ROW(OLD."investigation_id",OLD."repair_run_id",OLD."baseline_id",OLD."workspace_id",OLD."github_repository_id",OLD."installation_id",OLD."base_commit_sha",OLD."profile_identity",OLD."provider_id",OLD."model_id",OLD."protocol_version",OLD."created_at") IS DISTINCT FROM ROW(NEW."investigation_id",NEW."repair_run_id",NEW."baseline_id",NEW."workspace_id",NEW."github_repository_id",NEW."installation_id",NEW."base_commit_sha",NEW."profile_identity",NEW."provider_id",NEW."model_id",NEW."protocol_version",NEW."created_at") THEN RAISE EXCEPTION 'AI investigation authority is immutable'; END IF;
	IF OLD."queued_at" IS DISTINCT FROM NEW."queued_at" AND NOT (OLD."state" = 'created' AND NEW."state" = 'queued' AND OLD."queued_at" IS NULL AND NEW."queued_at" IS NOT NULL) THEN RAISE EXCEPTION 'AI investigation queue time is immutable'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "ai_investigation_update_guard" BEFORE UPDATE OR DELETE ON "ai_investigation" FOR EACH ROW EXECUTE FUNCTION "guard_ai_investigation_update"();--> statement-breakpoint
CREATE FUNCTION "guard_ai_investigation_event_mutation"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'AI investigation events are append-only'; END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "ai_investigation_event_mutation_guard" BEFORE UPDATE OR DELETE ON "ai_investigation_event" FOR EACH ROW EXECUTE FUNCTION "guard_ai_investigation_event_mutation"();
