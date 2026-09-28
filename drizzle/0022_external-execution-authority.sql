CREATE TABLE "execution_budget_grant" (
  "id" text PRIMARY KEY NOT NULL,
  "version" integer NOT NULL,
  "scope" text NOT NULL,
  "workspace_id" text,
  "repair_run_id" text,
  "github_repository_id" bigint,
  "base_commit_sha" text,
  "operation_category" text,
  "provider_id" text,
  "model_id" text,
  "acceptance_purpose" text,
  "max_logical_requests" integer NOT NULL,
  "max_provider_attempts" integer NOT NULL,
  "max_input_tokens" integer NOT NULL,
  "max_output_tokens" integer NOT NULL,
  "max_sandbox_identities" integer NOT NULL,
  "max_sandbox_runtime_ms" integer NOT NULL,
  "sandbox_resource_class" text,
  "max_verification_attempts" integer NOT NULL,
  "max_repair_loop_iterations" integer NOT NULL,
  "max_concurrent_external_operations" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "authorized_by" text NOT NULL,
  "grant_identity" text NOT NULL UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "execution_budget_grant_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "execution_budget_grant_version_check" CHECK ("version" = 1),
  CONSTRAINT "execution_budget_grant_scope_check" CHECK ("scope" in ('account','operation','one_shot')),
  CONSTRAINT "execution_budget_grant_hash_check" CHECK ("grant_identity" ~ '^[0-9a-f]{64}$' and ("base_commit_sha" is null or "base_commit_sha" ~ '^[0-9a-f]{40}$')),
  CONSTRAINT "execution_budget_grant_category_check" CHECK ("operation_category" is null or "operation_category" in ('gemini_investigation','gemini_candidate_generation','sandbox_baseline','sandbox_verification','repair_loop_iteration','release_acceptance_one_shot')),
  CONSTRAINT "execution_budget_grant_resource_check" CHECK ("sandbox_resource_class" is null or "sandbox_resource_class" in ('vcpu_1','vcpu_2','vcpu_4','vcpu_8')),
  CONSTRAINT "execution_budget_grant_limits_check" CHECK ("max_logical_requests" between 0 and 10000 and "max_provider_attempts" between 0 and 100000 and "max_input_tokens" between 0 and 100000000 and "max_output_tokens" between 0 and 100000000 and "max_sandbox_identities" between 0 and 1000 and "max_sandbox_runtime_ms" between 0 and 86400000 and "max_verification_attempts" between 0 and 1000 and "max_repair_loop_iterations" between 0 and 1000 and "max_concurrent_external_operations" between 0 and 1000),
  CONSTRAINT "execution_budget_grant_scope_facts_check" CHECK (("scope" = 'account' and "workspace_id" is null and "repair_run_id" is null and "github_repository_id" is null and "base_commit_sha" is null and "operation_category" is null and "provider_id" is null and "model_id" is null and "acceptance_purpose" is null and "max_concurrent_external_operations" > 0) or ("scope" = 'operation' and "workspace_id" is not null and "operation_category" is not null and "provider_id" is not null and "acceptance_purpose" is null) or ("scope" = 'one_shot' and "workspace_id" is not null and "repair_run_id" is not null and "github_repository_id" is not null and "base_commit_sha" is not null and "operation_category" = 'release_acceptance_one_shot' and "provider_id" is not null and char_length("acceptance_purpose") between 1 and 80))
);--> statement-breakpoint
ALTER TABLE "execution_budget_grant" ADD CONSTRAINT "execution_budget_grant_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "execution_budget_grant" ADD CONSTRAINT "execution_budget_grant_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "repair_run"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX "execution_budget_grant_scope_expiry_idx" ON "execution_budget_grant" ("scope","expires_at");--> statement-breakpoint
CREATE INDEX "execution_budget_grant_workspace_run_idx" ON "execution_budget_grant" ("workspace_id","repair_run_id");--> statement-breakpoint

CREATE TABLE "execution_budget_grant_revocation" (
  "id" text PRIMARY KEY NOT NULL,
  "grant_id" text NOT NULL UNIQUE,
  "reason_code" text NOT NULL,
  "revoked_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "execution_budget_grant_revocation_safe_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "reason_code" ~ '^[a-z_]{1,64}$' and char_length("revoked_by") between 1 and 200)
);--> statement-breakpoint
ALTER TABLE "execution_budget_grant_revocation" ADD CONSTRAINT "execution_budget_grant_revocation_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "execution_budget_grant"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE TABLE "external_execution_semaphore" (
  "id" text PRIMARY KEY NOT NULL,
  "next_fence" bigint NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "external_execution_semaphore_singleton_check" CHECK ("id" = 'global' and "next_fence" >= 0)
);--> statement-breakpoint
INSERT INTO "external_execution_semaphore" ("id","next_fence") VALUES ('global',0);--> statement-breakpoint
CREATE FUNCTION "guard_external_execution_semaphore_mutation"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD."id" <> 'global' OR NEW."id" <> OLD."id" OR NEW."next_fence" <= OLD."next_fence" THEN RAISE EXCEPTION 'external execution semaphore mutation invalid'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "external_execution_semaphore_mutation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "external_execution_semaphore" FOR EACH ROW EXECUTE FUNCTION "guard_external_execution_semaphore_mutation"();--> statement-breakpoint

CREATE TABLE "external_execution_reservation" (
  "id" text PRIMARY KEY NOT NULL,
  "version" integer NOT NULL,
  "grant_id" text NOT NULL,
  "account_grant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "repair_run_id" text,
  "github_repository_id" bigint,
  "base_commit_sha" text,
  "operation_category" text NOT NULL,
  "provider_id" text NOT NULL,
  "model_id" text,
  "acceptance_purpose" text,
  "operation_key" text NOT NULL UNIQUE,
  "reserved_logical_requests" integer NOT NULL,
  "reserved_provider_attempts" integer NOT NULL,
  "reserved_input_tokens" integer NOT NULL,
  "reserved_output_tokens" integer NOT NULL,
  "reserved_sandbox_identities" integer NOT NULL,
  "reserved_sandbox_runtime_ms" integer NOT NULL,
  "sandbox_resource_class" text,
  "reserved_verification_attempts" integer NOT NULL,
  "reserved_repair_loop_iterations" integer NOT NULL,
  "fence" bigint NOT NULL UNIQUE,
  "reservation_identity" text NOT NULL UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "external_execution_reservation_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "operation_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "external_execution_reservation_version_check" CHECK ("version" = 1),
  CONSTRAINT "external_execution_reservation_hash_check" CHECK ("reservation_identity" ~ '^[0-9a-f]{64}$' and ("base_commit_sha" is null or "base_commit_sha" ~ '^[0-9a-f]{40}$')),
  CONSTRAINT "external_execution_reservation_category_check" CHECK ("operation_category" in ('gemini_investigation','gemini_candidate_generation','sandbox_baseline','sandbox_verification','repair_loop_iteration','release_acceptance_one_shot')),
  CONSTRAINT "external_execution_reservation_limits_check" CHECK ("reserved_logical_requests" between 0 and 10000 and "reserved_provider_attempts" between 0 and 100000 and "reserved_input_tokens" between 0 and 100000000 and "reserved_output_tokens" between 0 and 100000000 and "reserved_sandbox_identities" between 0 and 1000 and "reserved_sandbox_runtime_ms" between 0 and 86400000 and "reserved_verification_attempts" between 0 and 1000 and "reserved_repair_loop_iterations" between 0 and 1000 and "fence" > 0),
  CONSTRAINT "external_execution_reservation_resource_check" CHECK (("sandbox_resource_class" is null or "sandbox_resource_class" in ('vcpu_1','vcpu_2','vcpu_4','vcpu_8')) and ("acceptance_purpose" is null or char_length("acceptance_purpose") between 1 and 80))
);--> statement-breakpoint
ALTER TABLE "external_execution_reservation" ADD CONSTRAINT "external_execution_reservation_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "execution_budget_grant"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "external_execution_reservation" ADD CONSTRAINT "external_execution_reservation_account_grant_id_fk" FOREIGN KEY ("account_grant_id") REFERENCES "execution_budget_grant"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "external_execution_reservation" ADD CONSTRAINT "external_execution_reservation_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "external_execution_reservation" ADD CONSTRAINT "external_execution_reservation_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "repair_run"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX "external_execution_reservation_grant_created_idx" ON "external_execution_reservation" ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "external_execution_reservation_account_grant_created_idx" ON "external_execution_reservation" ("account_grant_id","created_at");--> statement-breakpoint
CREATE INDEX "external_execution_reservation_workspace_created_idx" ON "external_execution_reservation" ("workspace_id","created_at");--> statement-breakpoint

CREATE TABLE "external_execution_lease" (
  "reservation_id" text PRIMARY KEY NOT NULL,
  "ownership_token" text NOT NULL,
  "fence" bigint NOT NULL UNIQUE,
  "state" text NOT NULL,
  "heartbeat_at" timestamp with time zone NOT NULL,
  "lease_expires_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "failure_code" text,
  CONSTRAINT "external_execution_lease_uuid_check" CHECK ("ownership_token" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "external_execution_lease_state_check" CHECK ("state" in ('active','succeeded','failed','ambiguous','expired')),
  CONSTRAINT "external_execution_lease_facts_check" CHECK (("state" = 'active' and "completed_at" is null and "failure_code" is null) or ("state" = 'succeeded' and "completed_at" is not null and "failure_code" is null) or ("state" in ('failed','ambiguous','expired') and "completed_at" is not null and "failure_code" ~ '^[a-z_]{1,64}$'))
);--> statement-breakpoint
ALTER TABLE "external_execution_lease" ADD CONSTRAINT "external_execution_lease_reservation_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "external_execution_reservation"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX "external_execution_lease_state_expiry_idx" ON "external_execution_lease" ("state","lease_expires_at");--> statement-breakpoint

CREATE TABLE "external_execution_event" (
  "id" text PRIMARY KEY NOT NULL,
  "reservation_id" text NOT NULL,
  "event_type" text NOT NULL,
  "attempt_ordinal" integer,
  "failure_code" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "external_execution_event_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "external_execution_event_type_check" CHECK ("event_type" in ('reserved','attempt_started','attempt_succeeded','attempt_failed','attempt_ambiguous','lease_renewed','completed','failed','expired')),
  CONSTRAINT "external_execution_event_facts_check" CHECK (("event_type" like 'attempt_%' and "attempt_ordinal" between 1 and 100000) or ("event_type" not like 'attempt_%' and "attempt_ordinal" is null)),
  CONSTRAINT "external_execution_event_safe_check" CHECK (("failure_code" is null or "failure_code" ~ '^[a-z_]{1,64}$') and ("input_tokens" is null or "input_tokens" >= 0) and ("output_tokens" is null or "output_tokens" >= 0) and (("event_type" = 'attempt_started' and "failure_code" is null and "input_tokens" is null and "output_tokens" is null) or ("event_type" = 'attempt_succeeded' and "failure_code" is null) or "event_type" in ('attempt_failed','attempt_ambiguous') or ("event_type" in ('reserved','lease_renewed','completed') and "failure_code" is null and "input_tokens" is null and "output_tokens" is null) or ("event_type" in ('failed','expired') and "failure_code" is not null and "input_tokens" is null and "output_tokens" is null)))
);--> statement-breakpoint
ALTER TABLE "external_execution_event" ADD CONSTRAINT "external_execution_event_reservation_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "external_execution_reservation"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE UNIQUE INDEX "external_execution_event_attempt_type_unique" ON "external_execution_event" ("reservation_id","attempt_ordinal","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "external_execution_event_attempt_outcome_unique" ON "external_execution_event" ("reservation_id","attempt_ordinal") WHERE "event_type" in ('attempt_succeeded','attempt_failed','attempt_ambiguous');--> statement-breakpoint
CREATE UNIQUE INDEX "external_execution_event_reserved_unique" ON "external_execution_event" ("reservation_id") WHERE "event_type" = 'reserved';--> statement-breakpoint
CREATE UNIQUE INDEX "external_execution_event_terminal_unique" ON "external_execution_event" ("reservation_id") WHERE "event_type" in ('completed','failed','expired');--> statement-breakpoint
CREATE INDEX "external_execution_event_reservation_created_idx" ON "external_execution_event" ("reservation_id","created_at");--> statement-breakpoint

CREATE TABLE "release_acceptance" (
  "id" text PRIMARY KEY NOT NULL,
  "version" integer NOT NULL,
  "kind" text NOT NULL,
  "state" text NOT NULL,
  "boundary_version" text NOT NULL,
  "released_commit_sha" text NOT NULL,
  "protocol_version" integer,
  "workspace_id" text NOT NULL,
  "repair_run_id" text,
  "repair_loop_id" text,
  "repair_loop_iteration_id" text,
  "ai_candidate_generation_id" text,
  "repair_candidate_id" text,
  "candidate_identity" text,
  "candidate_verification_id" text,
  "verification_evidence_id" text,
  "verification_evidence_identity" text,
  "objective_contract_hash" text,
  "objective_evidence_hash" text,
  "human_review_decision_id" text,
  "repair_publication_id" text,
  "provider_id" text,
  "model_id" text,
  "sandbox_execution_identity" text,
  "execution_budget_grant_id" text,
  "execution_reservation_ids" jsonb NOT NULL,
  "reviewed_by" text NOT NULL,
  "accepted_at" timestamp with time zone NOT NULL,
  "acceptance_identity" text NOT NULL UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "release_acceptance_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "release_acceptance_version_check" CHECK ("version" = 1),
  CONSTRAINT "release_acceptance_kind_check" CHECK ("kind" in ('repair_loop_live','human_review_live','draft_publication_live','security_cost_control')),
  CONSTRAINT "release_acceptance_state_check" CHECK ("state" in ('pending','passed')),
  CONSTRAINT "release_acceptance_identity_check" CHECK ("released_commit_sha" ~ '^[0-9a-f]{40}$' and "acceptance_identity" ~ '^[0-9a-f]{64}$' and char_length("boundary_version") between 1 and 80 and jsonb_typeof("execution_reservation_ids") = 'array'),
  CONSTRAINT "release_acceptance_optional_hashes_check" CHECK (("candidate_identity" is null or "candidate_identity" ~ '^[0-9a-f]{64}$') and ("verification_evidence_identity" is null or "verification_evidence_identity" ~ '^[0-9a-f]{64}$') and ("objective_contract_hash" is null or "objective_contract_hash" ~ '^[0-9a-f]{64}$') and ("objective_evidence_hash" is null or "objective_evidence_hash" ~ '^[0-9a-f]{64}$') and ("sandbox_execution_identity" is null or "sandbox_execution_identity" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "release_acceptance_kind_facts_check" CHECK (("kind" = 'repair_loop_live' and "protocol_version" is not null and "repair_run_id" is not null and "repair_loop_id" is not null and "repair_loop_iteration_id" is not null and "ai_candidate_generation_id" is not null and "repair_candidate_id" is not null and "candidate_identity" is not null and "candidate_verification_id" is not null and "verification_evidence_id" is not null and "verification_evidence_identity" is not null and "objective_contract_hash" is not null and "objective_evidence_hash" is not null and "provider_id" is not null and "model_id" is not null and "sandbox_execution_identity" is not null and "execution_budget_grant_id" is not null and jsonb_array_length("execution_reservation_ids") > 0 and "human_review_decision_id" is null and "repair_publication_id" is null) or ("kind" = 'human_review_live' and "human_review_decision_id" is not null and "repair_run_id" is not null and "repair_candidate_id" is not null and "candidate_verification_id" is not null and "repair_publication_id" is null) or ("kind" = 'draft_publication_live' and "repair_publication_id" is not null and "human_review_decision_id" is not null) or ("kind" = 'security_cost_control' and "execution_budget_grant_id" is not null and "repair_run_id" is null and "repair_loop_id" is null and "human_review_decision_id" is null and "repair_publication_id" is null))
);--> statement-breakpoint
ALTER TABLE "release_acceptance" ADD CONSTRAINT "release_acceptance_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "release_acceptance" ADD CONSTRAINT "release_acceptance_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "repair_run"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "release_acceptance" ADD CONSTRAINT "release_acceptance_repair_loop_id_fk" FOREIGN KEY ("repair_loop_id") REFERENCES "repair_loop"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "release_acceptance" ADD CONSTRAINT "release_acceptance_repair_loop_iteration_id_fk" FOREIGN KEY ("repair_loop_iteration_id") REFERENCES "repair_loop_iteration"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "release_acceptance" ADD CONSTRAINT "release_acceptance_ai_candidate_generation_id_fk" FOREIGN KEY ("ai_candidate_generation_id") REFERENCES "ai_candidate_generation"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "release_acceptance" ADD CONSTRAINT "release_acceptance_repair_candidate_id_fk" FOREIGN KEY ("repair_candidate_id") REFERENCES "repair_candidate"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "release_acceptance" ADD CONSTRAINT "release_acceptance_candidate_verification_id_fk" FOREIGN KEY ("candidate_verification_id") REFERENCES "candidate_verification"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "release_acceptance" ADD CONSTRAINT "release_acceptance_verification_evidence_id_fk" FOREIGN KEY ("verification_evidence_id") REFERENCES "candidate_verification_evidence"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "release_acceptance" ADD CONSTRAINT "release_acceptance_human_review_decision_id_fk" FOREIGN KEY ("human_review_decision_id") REFERENCES "human_review_decision"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "release_acceptance" ADD CONSTRAINT "release_acceptance_repair_publication_id_fk" FOREIGN KEY ("repair_publication_id") REFERENCES "repair_publication"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "release_acceptance" ADD CONSTRAINT "release_acceptance_execution_budget_grant_id_fk" FOREIGN KEY ("execution_budget_grant_id") REFERENCES "execution_budget_grant"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX "release_acceptance_kind_workspace_idx" ON "release_acceptance" ("kind","workspace_id","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "release_acceptance_passed_boundary_unique" ON "release_acceptance" ("kind","workspace_id","released_commit_sha","boundary_version",("protocol_version" IS NULL),coalesce("protocol_version",0),("provider_id" IS NULL),coalesce("provider_id",''),("model_id" IS NULL),coalesce("model_id",'')) WHERE "state" = 'passed';--> statement-breakpoint

CREATE TABLE "release_acceptance_revocation" (
  "id" text PRIMARY KEY NOT NULL,
  "acceptance_id" text NOT NULL UNIQUE,
  "reason_code" text NOT NULL,
  "revoked_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "release_acceptance_revocation_safe_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "reason_code" ~ '^[a-z_]{1,64}$' and char_length("revoked_by") between 1 and 200)
);--> statement-breakpoint
ALTER TABLE "release_acceptance_revocation" ADD CONSTRAINT "release_acceptance_revocation_acceptance_id_fk" FOREIGN KEY ("acceptance_id") REFERENCES "release_acceptance"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE FUNCTION "guard_execution_budget_grant_mutation"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'execution budget grants are immutable'; END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "execution_budget_grant_mutation_guard" BEFORE UPDATE OR DELETE ON "execution_budget_grant" FOR EACH ROW EXECUTE FUNCTION "guard_execution_budget_grant_mutation"();--> statement-breakpoint
CREATE FUNCTION "guard_execution_budget_grant_revocation_mutation"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'execution budget revocations are append only'; END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "execution_budget_grant_revocation_mutation_guard" BEFORE UPDATE OR DELETE ON "execution_budget_grant_revocation" FOR EACH ROW EXECUTE FUNCTION "guard_execution_budget_grant_revocation_mutation"();--> statement-breakpoint

CREATE FUNCTION "guard_external_execution_reservation_insert"() RETURNS trigger AS $$
DECLARE g "execution_budget_grant"%ROWTYPE; a "execution_budget_grant"%ROWTYPE; used record; account_used record;
BEGIN
  PERFORM "id" FROM "execution_budget_grant" WHERE "id" IN (NEW."grant_id",NEW."account_grant_id") ORDER BY "id" FOR UPDATE;
  SELECT * INTO g FROM "execution_budget_grant" WHERE "id" = NEW."grant_id";
  SELECT * INTO a FROM "execution_budget_grant" WHERE "id" = NEW."account_grant_id";
  IF g."id" IS NULL OR a."id" IS NULL OR a."scope" <> 'account' THEN RAISE EXCEPTION 'execution_authority_missing'; END IF;
  IF EXISTS (SELECT 1 FROM "execution_budget_grant_revocation" r WHERE r."grant_id" IN (g."id",a."id")) THEN RAISE EXCEPTION 'execution_authority_revoked'; END IF;
  IF g."expires_at" <= NEW."created_at" OR a."expires_at" <= NEW."created_at" THEN RAISE EXCEPTION 'execution_authority_expired'; END IF;
  IF g."scope" NOT IN ('operation','one_shot') OR g."workspace_id" IS DISTINCT FROM NEW."workspace_id" OR g."repair_run_id" IS DISTINCT FROM NEW."repair_run_id" OR g."github_repository_id" IS DISTINCT FROM NEW."github_repository_id" OR g."base_commit_sha" IS DISTINCT FROM NEW."base_commit_sha" OR g."operation_category" IS DISTINCT FROM NEW."operation_category" OR g."provider_id" IS DISTINCT FROM NEW."provider_id" OR g."model_id" IS DISTINCT FROM NEW."model_id" OR g."acceptance_purpose" IS DISTINCT FROM NEW."acceptance_purpose" OR g."sandbox_resource_class" IS DISTINCT FROM NEW."sandbox_resource_class" THEN RAISE EXCEPTION 'execution_authority_mismatch'; END IF;
  SELECT coalesce(sum("reserved_logical_requests"),0) logical, coalesce(sum("reserved_provider_attempts"),0) attempts, coalesce(sum("reserved_input_tokens"),0) input_tokens, coalesce(sum("reserved_output_tokens"),0) output_tokens, coalesce(sum("reserved_sandbox_identities"),0) sandboxes, coalesce(sum("reserved_sandbox_runtime_ms"),0) runtime, coalesce(sum("reserved_verification_attempts"),0) verifications, coalesce(sum("reserved_repair_loop_iterations"),0) iterations INTO used FROM "external_execution_reservation" WHERE "grant_id" = g."id";
  IF used.logical + NEW."reserved_logical_requests" > g."max_logical_requests" OR used.attempts + NEW."reserved_provider_attempts" > g."max_provider_attempts" OR used.input_tokens + NEW."reserved_input_tokens" > g."max_input_tokens" OR used.output_tokens + NEW."reserved_output_tokens" > g."max_output_tokens" OR used.sandboxes + NEW."reserved_sandbox_identities" > g."max_sandbox_identities" OR used.runtime + NEW."reserved_sandbox_runtime_ms" > g."max_sandbox_runtime_ms" OR used.verifications + NEW."reserved_verification_attempts" > g."max_verification_attempts" OR used.iterations + NEW."reserved_repair_loop_iterations" > g."max_repair_loop_iterations" THEN RAISE EXCEPTION 'execution_budget_exhausted'; END IF;
  SELECT coalesce(sum("reserved_logical_requests"),0) logical, coalesce(sum("reserved_provider_attempts"),0) attempts, coalesce(sum("reserved_input_tokens"),0) input_tokens, coalesce(sum("reserved_output_tokens"),0) output_tokens, coalesce(sum("reserved_sandbox_identities"),0) sandboxes, coalesce(sum("reserved_sandbox_runtime_ms"),0) runtime, coalesce(sum("reserved_verification_attempts"),0) verifications, coalesce(sum("reserved_repair_loop_iterations"),0) iterations INTO account_used FROM "external_execution_reservation" WHERE "account_grant_id" = a."id";
  IF account_used.logical + NEW."reserved_logical_requests" > a."max_logical_requests" OR account_used.attempts + NEW."reserved_provider_attempts" > a."max_provider_attempts" OR account_used.input_tokens + NEW."reserved_input_tokens" > a."max_input_tokens" OR account_used.output_tokens + NEW."reserved_output_tokens" > a."max_output_tokens" OR account_used.sandboxes + NEW."reserved_sandbox_identities" > a."max_sandbox_identities" OR account_used.runtime + NEW."reserved_sandbox_runtime_ms" > a."max_sandbox_runtime_ms" OR account_used.verifications + NEW."reserved_verification_attempts" > a."max_verification_attempts" OR account_used.iterations + NEW."reserved_repair_loop_iterations" > a."max_repair_loop_iterations" THEN RAISE EXCEPTION 'execution_budget_exhausted'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "external_execution_reservation_insert_guard" BEFORE INSERT ON "external_execution_reservation" FOR EACH ROW EXECUTE FUNCTION "guard_external_execution_reservation_insert"();--> statement-breakpoint
CREATE FUNCTION "guard_external_execution_reservation_mutation"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'external execution reservations are immutable'; END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "external_execution_reservation_mutation_guard" BEFORE UPDATE OR DELETE ON "external_execution_reservation" FOR EACH ROW EXECUTE FUNCTION "guard_external_execution_reservation_mutation"();--> statement-breakpoint

CREATE FUNCTION "guard_external_execution_lease_insert"() RETURNS trigger AS $$
DECLARE r "external_execution_reservation"%ROWTYPE; limit_value integer; active_count integer;
BEGIN
  PERFORM 1 FROM "external_execution_semaphore" WHERE "id" = 'global' FOR UPDATE;
  SELECT * INTO r FROM "external_execution_reservation" WHERE "id" = NEW."reservation_id";
  SELECT "max_concurrent_external_operations" INTO limit_value FROM "execution_budget_grant" WHERE "id" = r."account_grant_id";
  SELECT count(*) INTO active_count FROM "external_execution_lease" WHERE "state" = 'active' AND "lease_expires_at" > NEW."heartbeat_at";
  IF r."id" IS NULL OR NEW."fence" <> r."fence" THEN RAISE EXCEPTION 'execution_authority_mismatch'; END IF;
  IF active_count >= limit_value THEN RAISE EXCEPTION 'external_concurrency_unavailable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "external_execution_lease_insert_guard" BEFORE INSERT ON "external_execution_lease" FOR EACH ROW EXECUTE FUNCTION "guard_external_execution_lease_insert"();--> statement-breakpoint
CREATE FUNCTION "guard_external_execution_lease_mutation"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'external execution leases are immutable'; END IF;
  IF ROW(OLD."reservation_id",OLD."ownership_token",OLD."fence") IS DISTINCT FROM ROW(NEW."reservation_id",NEW."ownership_token",NEW."fence") THEN RAISE EXCEPTION 'external execution lease authority is immutable'; END IF;
  IF OLD."state" <> 'active' THEN RAISE EXCEPTION 'terminal external execution lease is immutable'; END IF;
  IF NEW."state" NOT IN ('active','succeeded','failed','ambiguous','expired') OR NEW."heartbeat_at" < OLD."heartbeat_at" OR NEW."lease_expires_at" < OLD."lease_expires_at" THEN RAISE EXCEPTION 'external execution lease transition invalid'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "external_execution_lease_mutation_guard" BEFORE UPDATE OR DELETE ON "external_execution_lease" FOR EACH ROW EXECUTE FUNCTION "guard_external_execution_lease_mutation"();--> statement-breakpoint

CREATE FUNCTION "guard_external_execution_event_insert"() RETURNS trigger AS $$
DECLARE lease_state text; allowance integer; started integer; input_allowance integer; output_allowance integer; used_input integer; used_output integer;
BEGIN
  SELECT "state" INTO lease_state FROM "external_execution_lease" WHERE "reservation_id" = NEW."reservation_id" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'execution_authority_missing'; END IF;
  IF NEW."event_type" IN ('reserved','attempt_started','attempt_succeeded','attempt_failed','attempt_ambiguous','lease_renewed') AND lease_state <> 'active' THEN RAISE EXCEPTION 'execution event lease state invalid'; END IF;
  IF NEW."event_type" = 'completed' AND lease_state <> 'succeeded' THEN RAISE EXCEPTION 'execution event lease state invalid'; END IF;
  IF NEW."event_type" = 'failed' AND lease_state NOT IN ('failed','ambiguous') THEN RAISE EXCEPTION 'execution event lease state invalid'; END IF;
  IF NEW."event_type" = 'expired' AND lease_state <> 'expired' THEN RAISE EXCEPTION 'execution event lease state invalid'; END IF;
  IF NEW."event_type" = 'attempt_started' THEN
    SELECT "reserved_provider_attempts" INTO allowance FROM "external_execution_reservation" WHERE "id" = NEW."reservation_id";
    SELECT count(*) INTO started FROM "external_execution_event" WHERE "reservation_id" = NEW."reservation_id" AND "event_type" = 'attempt_started';
    IF allowance IS NULL OR started >= allowance THEN RAISE EXCEPTION 'execution_budget_exhausted'; END IF;
    IF NEW."attempt_ordinal" <> started + 1 THEN RAISE EXCEPTION 'execution attempt ordinal invalid'; END IF;
  END IF;
  IF NEW."event_type" IN ('attempt_succeeded','attempt_failed','attempt_ambiguous') THEN
    IF NOT EXISTS (SELECT 1 FROM "external_execution_event" e WHERE e."reservation_id" = NEW."reservation_id" AND e."event_type" = 'attempt_started' AND e."attempt_ordinal" = NEW."attempt_ordinal") OR
       EXISTS (SELECT 1 FROM "external_execution_event" e WHERE e."reservation_id" = NEW."reservation_id" AND e."event_type" IN ('attempt_succeeded','attempt_failed','attempt_ambiguous') AND e."attempt_ordinal" = NEW."attempt_ordinal") THEN
      RAISE EXCEPTION 'execution attempt outcome invalid';
    END IF;
    SELECT "reserved_input_tokens", "reserved_output_tokens" INTO input_allowance, output_allowance FROM "external_execution_reservation" WHERE "id" = NEW."reservation_id";
    SELECT coalesce(sum("input_tokens"),0), coalesce(sum("output_tokens"),0) INTO used_input, used_output FROM "external_execution_event" WHERE "reservation_id" = NEW."reservation_id" AND "event_type" IN ('attempt_succeeded','attempt_failed','attempt_ambiguous');
    IF used_input + coalesce(NEW."input_tokens",0) > input_allowance OR used_output + coalesce(NEW."output_tokens",0) > output_allowance THEN RAISE EXCEPTION 'execution_budget_exhausted'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "external_execution_event_insert_guard" BEFORE INSERT ON "external_execution_event" FOR EACH ROW EXECUTE FUNCTION "guard_external_execution_event_insert"();--> statement-breakpoint
CREATE FUNCTION "guard_external_execution_event_mutation"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'external execution events are append only'; END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "external_execution_event_mutation_guard" BEFORE UPDATE OR DELETE ON "external_execution_event" FOR EACH ROW EXECUTE FUNCTION "guard_external_execution_event_mutation"();--> statement-breakpoint

CREATE FUNCTION "guard_release_acceptance_insert"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "release_acceptance" a
    WHERE a."kind" = NEW."kind" AND a."workspace_id" = NEW."workspace_id" AND a."released_commit_sha" = NEW."released_commit_sha" AND
      a."boundary_version" = NEW."boundary_version" AND a."protocol_version" IS NOT DISTINCT FROM NEW."protocol_version" AND
      a."provider_id" IS NOT DISTINCT FROM NEW."provider_id" AND a."model_id" IS NOT DISTINCT FROM NEW."model_id" AND
      (a."state" = 'passed' OR NEW."state" = 'pending')
  ) THEN RAISE EXCEPTION 'acceptance boundary already recorded'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."execution_reservation_ids") value LEFT JOIN "external_execution_reservation" r ON r."id" = value WHERE r."id" IS NULL OR r."workspace_id" <> NEW."workspace_id") THEN RAISE EXCEPTION 'acceptance evidence mismatch'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements_text(NEW."execution_reservation_ids")) <> (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(NEW."execution_reservation_ids") value) THEN RAISE EXCEPTION 'acceptance evidence mismatch'; END IF;
  IF NEW."kind" = 'repair_loop_live' AND NOT EXISTS (
    SELECT 1 FROM "repair_loop" l JOIN "repair_loop_iteration" i ON i."repair_loop_id" = l."id" JOIN "ai_candidate_generation" g ON g."id" = i."ai_candidate_generation_id" JOIN "repair_candidate" c ON c."id" = g."repair_candidate_id" JOIN "candidate_verification" v ON v."id" = i."candidate_verification_id" JOIN "candidate_verification_evidence" e ON e."id" = v."evidence_id"
    WHERE l."id" = NEW."repair_loop_id" AND l."repair_run_id" = NEW."repair_run_id" AND l."workspace_id" = NEW."workspace_id" AND l."state" = 'verified' AND l."selected_candidate_id" = NEW."repair_candidate_id" AND l."selected_verification_id" = NEW."candidate_verification_id" AND l."selected_evidence_id" = NEW."verification_evidence_id" AND i."id" = NEW."repair_loop_iteration_id" AND i."decision" = 'verified' AND i."objective_contract_hash" = NEW."objective_contract_hash" AND i."objective_evidence_hash" = NEW."objective_evidence_hash" AND g."id" = NEW."ai_candidate_generation_id" AND g."provider_id" = NEW."provider_id" AND g."model_id" = NEW."model_id" AND c."id" = NEW."repair_candidate_id" AND c."candidate_identity" = NEW."candidate_identity" AND v."id" = NEW."candidate_verification_id" AND e."id" = NEW."verification_evidence_id"
  ) THEN RAISE EXCEPTION 'acceptance evidence mismatch'; END IF;
  IF NEW."kind" = 'repair_loop_live' AND (NOT EXISTS (SELECT 1 FROM "execution_budget_grant" g WHERE g."id" = NEW."execution_budget_grant_id" AND g."scope" = 'account') OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."execution_reservation_ids") value JOIN "external_execution_reservation" r ON r."id" = value WHERE r."account_grant_id" <> NEW."execution_budget_grant_id" OR r."repair_run_id" <> NEW."repair_run_id") OR EXISTS (SELECT 1 FROM "external_execution_reservation" r WHERE r."workspace_id" = NEW."workspace_id" AND r."repair_run_id" = NEW."repair_run_id" AND NOT (NEW."execution_reservation_ids" ? r."id"))) THEN RAISE EXCEPTION 'acceptance evidence mismatch'; END IF;
  IF NEW."kind" = 'human_review_live' AND NOT EXISTS (
    SELECT 1 FROM "human_review_decision" d WHERE d."id" = NEW."human_review_decision_id" AND d."decision" = 'approved' AND d."workspace_id" = NEW."workspace_id" AND d."repair_run_id" = NEW."repair_run_id" AND d."repair_candidate_id" = NEW."repair_candidate_id" AND d."candidate_verification_id" = NEW."candidate_verification_id" AND (NEW."candidate_identity" IS NULL OR d."candidate_identity" = NEW."candidate_identity") AND (NEW."verification_evidence_id" IS NULL OR d."verification_evidence_id" = NEW."verification_evidence_id")
  ) THEN RAISE EXCEPTION 'acceptance evidence mismatch'; END IF;
  IF NEW."kind" = 'draft_publication_live' AND NOT EXISTS (
    SELECT 1 FROM "repair_publication" p WHERE p."id" = NEW."repair_publication_id" AND p."workspace_id" = NEW."workspace_id" AND p."human_review_decision_id" = NEW."human_review_decision_id" AND p."state" = 'published' AND (NEW."repair_run_id" IS NULL OR p."repair_run_id" = NEW."repair_run_id") AND (NEW."repair_candidate_id" IS NULL OR p."repair_candidate_id" = NEW."repair_candidate_id") AND (NEW."candidate_verification_id" IS NULL OR p."candidate_verification_id" = NEW."candidate_verification_id")
  ) THEN RAISE EXCEPTION 'acceptance evidence mismatch'; END IF;
  IF NEW."kind" = 'security_cost_control' AND NOT EXISTS (
    SELECT 1 FROM "execution_budget_grant" g WHERE g."id" = NEW."execution_budget_grant_id" AND (g."workspace_id" IS NULL OR g."workspace_id" = NEW."workspace_id")
  ) THEN RAISE EXCEPTION 'acceptance evidence mismatch'; END IF;
  IF NEW."kind" = 'security_cost_control' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."execution_reservation_ids") value JOIN "external_execution_reservation" r ON r."id" = value WHERE (EXISTS (SELECT 1 FROM "execution_budget_grant" g WHERE g."id" = NEW."execution_budget_grant_id" AND g."scope" = 'account') AND r."account_grant_id" <> NEW."execution_budget_grant_id") OR (EXISTS (SELECT 1 FROM "execution_budget_grant" g WHERE g."id" = NEW."execution_budget_grant_id" AND g."scope" <> 'account') AND r."grant_id" <> NEW."execution_budget_grant_id")) THEN RAISE EXCEPTION 'acceptance evidence mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "release_acceptance_insert_guard" BEFORE INSERT ON "release_acceptance" FOR EACH ROW EXECUTE FUNCTION "guard_release_acceptance_insert"();--> statement-breakpoint
CREATE FUNCTION "guard_release_acceptance_mutation"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'release acceptances are immutable'; END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "release_acceptance_mutation_guard" BEFORE UPDATE OR DELETE ON "release_acceptance" FOR EACH ROW EXECUTE FUNCTION "guard_release_acceptance_mutation"();--> statement-breakpoint
CREATE FUNCTION "guard_release_acceptance_revocation_mutation"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'release acceptance revocations are append only'; END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "release_acceptance_revocation_mutation_guard" BEFORE UPDATE OR DELETE ON "release_acceptance_revocation" FOR EACH ROW EXECUTE FUNCTION "guard_release_acceptance_revocation_mutation"();
