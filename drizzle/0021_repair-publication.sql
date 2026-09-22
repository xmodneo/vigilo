CREATE TABLE "repair_publication" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"workspace_id" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"repair_run_id" text NOT NULL,
	"repair_loop_id" text NOT NULL,
	"human_review_decision_id" text NOT NULL,
	"human_review_decision_identity" text NOT NULL,
	"repair_candidate_id" text NOT NULL,
	"candidate_identity" text NOT NULL,
	"candidate_verification_id" text NOT NULL,
	"verification_evidence_id" text NOT NULL,
	"verification_evidence_identity" text NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"baseline_id" text NOT NULL,
	"base_commit_sha" text NOT NULL,
	"profile_identity" text NOT NULL,
	"objective_contract_hash" text NOT NULL,
	"objective_evidence_hash" text NOT NULL,
	"repair_intent_id" text NOT NULL,
	"repair_objective" text NOT NULL,
	"repair_objective_hash" text NOT NULL,
	"target_branch" text NOT NULL,
	"target_base_branch" text,
	"pull_request_title" text NOT NULL,
	"pull_request_body" text NOT NULL,
	"pull_request_body_hash" text NOT NULL,
	"publication_intent_identity" text NOT NULL,
	"prepared_publication_identity" text,
	"expected_base_tree_sha" text,
	"expected_tree_sha" text,
	"expected_commit_sha" text,
	"state" text NOT NULL,
	"checkpoint" text NOT NULL,
	"remote_branch_commit_sha" text,
	"github_pull_request_id" bigint,
	"github_pull_request_number" integer,
	"github_pull_request_node_id" text,
	"github_pull_request_url" text,
	"idempotency_key" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"preparing_started_at" timestamp with time zone,
	"publishing_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_publication_repair_run_id_unique" UNIQUE("repair_run_id"),
	CONSTRAINT "repair_publication_repair_loop_id_unique" UNIQUE("repair_loop_id"),
	CONSTRAINT "repair_publication_decision_id_unique" UNIQUE("human_review_decision_id"),
	CONSTRAINT "repair_publication_intent_identity_unique" UNIQUE("publication_intent_identity"),
	CONSTRAINT "repair_publication_prepared_identity_unique" UNIQUE("prepared_publication_identity"),
	CONSTRAINT "repair_publication_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "idempotency_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_publication_version_check" CHECK ("version" = 1),
	CONSTRAINT "repair_publication_hashes_check" CHECK ("human_review_decision_identity" ~ '^[0-9a-f]{64}$' and "candidate_identity" ~ '^[0-9a-f]{64}$' and "verification_evidence_identity" ~ '^[0-9a-f]{64}$' and "profile_identity" ~ '^[0-9a-f]{64}$' and "objective_contract_hash" ~ '^[0-9a-f]{64}$' and "objective_evidence_hash" ~ '^[0-9a-f]{64}$' and "repair_objective_hash" ~ '^[0-9a-f]{64}$' and "pull_request_body_hash" ~ '^[0-9a-f]{64}$' and "publication_intent_identity" ~ '^[0-9a-f]{64}$' and ("prepared_publication_identity" is null or "prepared_publication_identity" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "repair_publication_git_check" CHECK ("base_commit_sha" ~ '^[0-9a-f]{40}$' and ("expected_base_tree_sha" is null or "expected_base_tree_sha" ~ '^[0-9a-f]{40}$') and ("expected_tree_sha" is null or "expected_tree_sha" ~ '^[0-9a-f]{40}$') and ("expected_commit_sha" is null or "expected_commit_sha" ~ '^[0-9a-f]{40}$') and ("remote_branch_commit_sha" is null or "remote_branch_commit_sha" ~ '^[0-9a-f]{40}$')),
	CONSTRAINT "repair_publication_state_check" CHECK ("state" in ('queued','preparing','publishing','published','failed','review_required')),
	CONSTRAINT "repair_publication_checkpoint_check" CHECK ("checkpoint" in ('reserved','authority_prepared','objects_verified','branch_create_requested','branch_verified','pr_create_requested','pr_verified','completed')),
	CONSTRAINT "repair_publication_safe_check" CHECK ("target_branch" ~ '^vigilo/repair/[0-9a-f]{64}$' and char_length("pull_request_title") between 1 and 256 and octet_length("pull_request_body") between 1 and 16384 and ("failure_code" is null or "failure_code" ~ '^[a-z_]{1,64}$')),
	CONSTRAINT "repair_publication_prepared_facts_check" CHECK (("prepared_publication_identity" is null and "target_base_branch" is null and "expected_base_tree_sha" is null and "expected_tree_sha" is null and "expected_commit_sha" is null) or ("prepared_publication_identity" is not null and "target_base_branch" is not null and char_length("target_base_branch") between 1 and 255 and "expected_base_tree_sha" is not null and "expected_tree_sha" is not null and "expected_commit_sha" is not null)),
	CONSTRAINT "repair_publication_pr_facts_check" CHECK (("github_pull_request_id" is null and "github_pull_request_number" is null and "github_pull_request_node_id" is null and "github_pull_request_url" is null) or ("github_pull_request_id" > 0 and "github_pull_request_number" > 0 and char_length("github_pull_request_node_id") between 1 and 255 and char_length("github_pull_request_url") between 1 and 2048)),
	CONSTRAINT "repair_publication_state_facts_check" CHECK (("state" = 'queued' and "checkpoint" = 'reserved' and "preparing_started_at" is null and "publishing_started_at" is null and "completed_at" is null and "failure_code" is null) or ("state" = 'preparing' and "checkpoint" = 'reserved' and "preparing_started_at" is not null and "publishing_started_at" is null and "completed_at" is null and "failure_code" is null) or ("state" = 'publishing' and "checkpoint" in ('authority_prepared','objects_verified','branch_create_requested','branch_verified','pr_create_requested','pr_verified') and "preparing_started_at" is not null and "publishing_started_at" is not null and "completed_at" is null and "failure_code" is null) or ("state" = 'published' and "checkpoint" = 'completed' and "remote_branch_commit_sha" is not null and "github_pull_request_id" is not null and "completed_at" is not null and "failure_code" is null) or ("state" = 'failed' and "completed_at" is not null and "failure_code" is not null) or ("state" = 'review_required' and "prepared_publication_identity" is not null and "completed_at" is not null and "failure_code" is not null))
);--> statement-breakpoint

ALTER TABLE "repair_publication" ADD CONSTRAINT "repair_publication_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_publication" ADD CONSTRAINT "repair_publication_requested_by_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_publication" ADD CONSTRAINT "repair_publication_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "repair_run"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_publication" ADD CONSTRAINT "repair_publication_repair_loop_id_fk" FOREIGN KEY ("repair_loop_id") REFERENCES "repair_loop"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_publication" ADD CONSTRAINT "repair_publication_decision_id_fk" FOREIGN KEY ("human_review_decision_id") REFERENCES "human_review_decision"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_publication" ADD CONSTRAINT "repair_publication_candidate_id_fk" FOREIGN KEY ("repair_candidate_id") REFERENCES "repair_candidate"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_publication" ADD CONSTRAINT "repair_publication_verification_id_fk" FOREIGN KEY ("candidate_verification_id") REFERENCES "candidate_verification"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_publication" ADD CONSTRAINT "repair_publication_evidence_id_fk" FOREIGN KEY ("verification_evidence_id") REFERENCES "candidate_verification_evidence"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_publication" ADD CONSTRAINT "repair_publication_baseline_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "repository_baseline"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_publication" ADD CONSTRAINT "repair_publication_repair_intent_id_fk" FOREIGN KEY ("repair_intent_id") REFERENCES "repair_intent"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE UNIQUE INDEX "repair_publication_workspace_idempotency_unique" ON "repair_publication" ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "repair_publication_repository_branch_unique" ON "repair_publication" ("github_repository_id","target_branch");--> statement-breakpoint
CREATE INDEX "repair_publication_workspace_created_idx" ON "repair_publication" ("workspace_id","created_at");--> statement-breakpoint

CREATE TABLE "repair_publication_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"queue_job_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"ownership_token" text NOT NULL,
	"state" text NOT NULL,
	"failure_code" text,
	"claimed_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "repair_publication_attempt_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "queue_job_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "ownership_token" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_publication_attempt_state_check" CHECK ("state" in ('active','succeeded','failed','abandoned') and "attempt_number" between 1 and 3 and ("failure_code" is null or "failure_code" ~ '^[a-z_]{1,64}$')),
	CONSTRAINT "repair_publication_attempt_facts_check" CHECK (("state" = 'active' and "failure_code" is null and "completed_at" is null) or ("state" = 'succeeded' and "failure_code" is null and "completed_at" is not null) or ("state" in ('failed','abandoned') and "failure_code" is not null and "completed_at" is not null))
);--> statement-breakpoint
ALTER TABLE "repair_publication_attempt" ADD CONSTRAINT "repair_publication_attempt_publication_id_fk" FOREIGN KEY ("publication_id") REFERENCES "repair_publication"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE UNIQUE INDEX "repair_publication_attempt_ordinal_unique" ON "repair_publication_attempt" ("publication_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "repair_publication_attempt_active_unique" ON "repair_publication_attempt" ("publication_id") WHERE "state" = 'active';--> statement-breakpoint

CREATE TABLE "repair_publication_event" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"attempt_id" text,
	"workspace_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"checkpoint" text NOT NULL,
	"event_type" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_publication_event_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_publication_event_state_check" CHECK (("from_state" is null or "from_state" in ('queued','preparing','publishing','published','failed','review_required')) and "to_state" in ('queued','preparing','publishing','published','failed','review_required')),
	CONSTRAINT "repair_publication_event_checkpoint_check" CHECK ("checkpoint" in ('reserved','authority_prepared','objects_verified','branch_create_requested','branch_verified','pr_create_requested','pr_verified','completed')),
	CONSTRAINT "repair_publication_event_type_check" CHECK ("event_type" in ('reserved','claimed','prepared','objects_verified','branch_requested','branch_verified','pr_requested','pr_verified','completed','failed','review_required','reconciled')),
	CONSTRAINT "repair_publication_event_safe_check" CHECK ("failure_code" is null or "failure_code" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "repair_publication_event_failure_check" CHECK (("event_type" in ('failed','review_required') and "failure_code" is not null) or ("event_type" not in ('failed','review_required') and "failure_code" is null))
);--> statement-breakpoint
ALTER TABLE "repair_publication_event" ADD CONSTRAINT "repair_publication_event_publication_id_fk" FOREIGN KEY ("publication_id") REFERENCES "repair_publication"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_publication_event" ADD CONSTRAINT "repair_publication_event_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "repair_publication_attempt"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "repair_publication_event" ADD CONSTRAINT "repair_publication_event_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX "repair_publication_event_publication_created_idx" ON "repair_publication_event" ("publication_id","created_at");--> statement-breakpoint

CREATE FUNCTION "guard_repair_publication_insert"() RETURNS trigger AS $$
BEGIN
	PERFORM 1 FROM "repair_run" r WHERE r."id" = NEW."repair_run_id" FOR UPDATE;
	IF NOT FOUND THEN RAISE EXCEPTION 'publication repair run not found'; END IF;
	IF NOT EXISTS (
		SELECT 1 FROM "human_review_decision" d
		JOIN "workspace" w ON w."id" = d."workspace_id"
		JOIN "repair_run" r ON r."id" = d."repair_run_id"
		JOIN "repair_loop" l ON l."id" = d."repair_loop_id"
		JOIN "repair_candidate" c ON c."id" = d."repair_candidate_id"
		JOIN "candidate_verification" v ON v."id" = d."candidate_verification_id"
		JOIN "candidate_verification_evidence" e ON e."id" = d."verification_evidence_id"
		JOIN "repair_intent" i ON i."repair_run_id" = r."id"
		WHERE d."id" = NEW."human_review_decision_id" AND d."decision" = 'approved'
		AND w."id" = NEW."workspace_id" AND w."owner_user_id" = NEW."requested_by_user_id"
		AND ROW(d."repair_run_id",d."repair_loop_id",d."decision_identity",d."repair_candidate_id",d."candidate_identity",d."candidate_verification_id",d."verification_evidence_id",d."verification_evidence_identity",d."github_repository_id",d."installation_id",d."baseline_id",d."base_commit_sha",d."profile_identity",d."objective_contract_hash",d."objective_evidence_hash")
			IS NOT DISTINCT FROM ROW(NEW."repair_run_id",NEW."repair_loop_id",NEW."human_review_decision_identity",NEW."repair_candidate_id",NEW."candidate_identity",NEW."candidate_verification_id",NEW."verification_evidence_id",NEW."verification_evidence_identity",NEW."github_repository_id",NEW."installation_id",NEW."baseline_id",NEW."base_commit_sha",NEW."profile_identity",NEW."objective_contract_hash",NEW."objective_evidence_hash")
		AND ROW(r."workspace_id",r."github_repository_id",r."installation_id",r."baseline_id",r."base_commit_sha",r."profile_identity")
			IS NOT DISTINCT FROM ROW(NEW."workspace_id",NEW."github_repository_id",NEW."installation_id",NEW."baseline_id",NEW."base_commit_sha",NEW."profile_identity")
		AND l."repair_run_id" = r."id" AND l."state" = 'verified'
		AND l."selected_candidate_id" = c."id" AND l."selected_verification_id" = v."id" AND l."selected_evidence_id" = e."id"
		AND c."state" = 'frozen' AND c."candidate_identity" = NEW."candidate_identity"
		AND v."state" = 'completed' AND v."candidate_id" = c."id" AND v."candidate_identity" = c."candidate_identity" AND v."evidence_id" = e."id"
		AND e."verification_id" = v."id" AND e."candidate_id" = c."id" AND e."candidate_identity" = c."candidate_identity"
		AND i."id" = NEW."repair_intent_id" AND i."workspace_id" = NEW."workspace_id"
		AND i."objective" = NEW."repair_objective" AND i."objective_hash" = NEW."repair_objective_hash"
	) THEN RAISE EXCEPTION 'publication authority mismatch'; END IF;
	IF NEW."state" <> 'queued' OR NEW."checkpoint" <> 'reserved' OR NEW."prepared_publication_identity" IS NOT NULL OR NEW."remote_branch_commit_sha" IS NOT NULL OR NEW."github_pull_request_id" IS NOT NULL THEN
		RAISE EXCEPTION 'publication initial state invalid';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_publication_insert_guard" BEFORE INSERT ON "repair_publication" FOR EACH ROW EXECUTE FUNCTION "guard_repair_publication_insert"();--> statement-breakpoint

CREATE FUNCTION "guard_repair_publication_update"() RETURNS trigger AS $$
DECLARE old_step integer; new_step integer;
BEGIN
	IF OLD."state" IN ('published','failed','review_required') THEN RAISE EXCEPTION 'terminal publication is immutable'; END IF;
	IF ROW(OLD."id",OLD."version",OLD."workspace_id",OLD."requested_by_user_id",OLD."repair_run_id",OLD."repair_loop_id",OLD."human_review_decision_id",OLD."human_review_decision_identity",OLD."repair_candidate_id",OLD."candidate_identity",OLD."candidate_verification_id",OLD."verification_evidence_id",OLD."verification_evidence_identity",OLD."github_repository_id",OLD."installation_id",OLD."baseline_id",OLD."base_commit_sha",OLD."profile_identity",OLD."objective_contract_hash",OLD."objective_evidence_hash",OLD."repair_intent_id",OLD."repair_objective",OLD."repair_objective_hash",OLD."target_branch",OLD."pull_request_title",OLD."pull_request_body",OLD."pull_request_body_hash",OLD."publication_intent_identity",OLD."idempotency_key",OLD."created_at")
		IS DISTINCT FROM ROW(NEW."id",NEW."version",NEW."workspace_id",NEW."requested_by_user_id",NEW."repair_run_id",NEW."repair_loop_id",NEW."human_review_decision_id",NEW."human_review_decision_identity",NEW."repair_candidate_id",NEW."candidate_identity",NEW."candidate_verification_id",NEW."verification_evidence_id",NEW."verification_evidence_identity",NEW."github_repository_id",NEW."installation_id",NEW."baseline_id",NEW."base_commit_sha",NEW."profile_identity",NEW."objective_contract_hash",NEW."objective_evidence_hash",NEW."repair_intent_id",NEW."repair_objective",NEW."repair_objective_hash",NEW."target_branch",NEW."pull_request_title",NEW."pull_request_body",NEW."pull_request_body_hash",NEW."publication_intent_identity",NEW."idempotency_key",NEW."created_at") THEN
		RAISE EXCEPTION 'publication authority is immutable';
	END IF;
	IF OLD."prepared_publication_identity" IS NOT NULL AND ROW(OLD."prepared_publication_identity",OLD."target_base_branch",OLD."expected_base_tree_sha",OLD."expected_tree_sha",OLD."expected_commit_sha") IS DISTINCT FROM ROW(NEW."prepared_publication_identity",NEW."target_base_branch",NEW."expected_base_tree_sha",NEW."expected_tree_sha",NEW."expected_commit_sha") THEN RAISE EXCEPTION 'prepared publication authority is immutable'; END IF;
	IF OLD."remote_branch_commit_sha" IS NOT NULL AND OLD."remote_branch_commit_sha" IS DISTINCT FROM NEW."remote_branch_commit_sha" THEN RAISE EXCEPTION 'remote branch authority is immutable'; END IF;
	IF OLD."github_pull_request_id" IS NOT NULL AND ROW(OLD."github_pull_request_id",OLD."github_pull_request_number",OLD."github_pull_request_node_id",OLD."github_pull_request_url") IS DISTINCT FROM ROW(NEW."github_pull_request_id",NEW."github_pull_request_number",NEW."github_pull_request_node_id",NEW."github_pull_request_url") THEN RAISE EXCEPTION 'remote pull request authority is immutable'; END IF;
	IF NOT ((OLD."state" = NEW."state") OR (OLD."state" = 'queued' AND NEW."state" IN ('preparing','failed')) OR (OLD."state" = 'preparing' AND NEW."state" IN ('publishing','failed')) OR (OLD."state" = 'publishing' AND NEW."state" IN ('published','failed','review_required'))) THEN RAISE EXCEPTION 'invalid publication transition'; END IF;
	old_step := array_position(ARRAY['reserved','authority_prepared','objects_verified','branch_create_requested','branch_verified','pr_create_requested','pr_verified','completed'], OLD."checkpoint");
	new_step := array_position(ARRAY['reserved','authority_prepared','objects_verified','branch_create_requested','branch_verified','pr_create_requested','pr_verified','completed'], NEW."checkpoint");
	IF new_step < old_step THEN RAISE EXCEPTION 'publication checkpoint regression'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_publication_update_guard" BEFORE UPDATE ON "repair_publication" FOR EACH ROW EXECUTE FUNCTION "guard_repair_publication_update"();--> statement-breakpoint

CREATE FUNCTION "guard_repair_publication_delete"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'publication records are immutable'; END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_publication_delete_guard" BEFORE DELETE ON "repair_publication" FOR EACH ROW EXECUTE FUNCTION "guard_repair_publication_delete"();--> statement-breakpoint

CREATE FUNCTION "guard_repair_publication_attempt_mutation"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'publication attempts are immutable'; END IF;
	IF ROW(OLD."id",OLD."publication_id",OLD."queue_job_id",OLD."attempt_number",OLD."ownership_token",OLD."claimed_at") IS DISTINCT FROM ROW(NEW."id",NEW."publication_id",NEW."queue_job_id",NEW."attempt_number",NEW."ownership_token",NEW."claimed_at") THEN RAISE EXCEPTION 'publication attempt authority is immutable'; END IF;
	IF OLD."state" <> 'active' OR NEW."state" NOT IN ('active','succeeded','failed','abandoned') THEN RAISE EXCEPTION 'publication attempt is immutable'; END IF;
	IF OLD."state" <> NEW."state" AND NEW."completed_at" IS NULL THEN RAISE EXCEPTION 'publication attempt completion invalid'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_publication_attempt_mutation_guard" BEFORE UPDATE OR DELETE ON "repair_publication_attempt" FOR EACH ROW EXECUTE FUNCTION "guard_repair_publication_attempt_mutation"();--> statement-breakpoint

CREATE FUNCTION "guard_repair_publication_event_insert"() RETURNS trigger AS $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM "repair_publication" p WHERE p."id" = NEW."publication_id" AND p."workspace_id" = NEW."workspace_id" AND p."state" = NEW."to_state" AND p."checkpoint" = NEW."checkpoint") THEN RAISE EXCEPTION 'publication event authority mismatch'; END IF;
	IF NEW."attempt_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "repair_publication_attempt" a WHERE a."id" = NEW."attempt_id" AND a."publication_id" = NEW."publication_id") THEN RAISE EXCEPTION 'publication event attempt mismatch'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_publication_event_insert_guard" BEFORE INSERT ON "repair_publication_event" FOR EACH ROW EXECUTE FUNCTION "guard_repair_publication_event_insert"();--> statement-breakpoint
CREATE FUNCTION "guard_repair_publication_event_mutation"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'publication events are append only'; END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_publication_event_mutation_guard" BEFORE UPDATE OR DELETE ON "repair_publication_event" FOR EACH ROW EXECUTE FUNCTION "guard_repair_publication_event_mutation"();--> statement-breakpoint

CREATE FUNCTION "guard_published_repair_intent_mutation"() RETURNS trigger AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM "repair_publication" p WHERE p."repair_intent_id" = OLD."id") THEN RAISE EXCEPTION 'published repair intent is immutable'; END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_publication_intent_mutation_guard" BEFORE UPDATE OR DELETE ON "repair_intent" FOR EACH ROW EXECUTE FUNCTION "guard_published_repair_intent_mutation"();
