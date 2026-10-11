-- Historical authority/evidence is deliberately left without invented provenance.
ALTER TABLE "execution_budget_grant" ADD COLUMN "authorized_release_sha" text;--> statement-breakpoint
ALTER TABLE "execution_budget_grant" ADD COLUMN "authorized_provider_account_identity" jsonb;--> statement-breakpoint
ALTER TABLE "external_execution_reservation" ADD COLUMN "executing_release_sha" text;--> statement-breakpoint
ALTER TABLE "external_execution_reservation" ADD COLUMN "executing_provider_account_identity" jsonb;--> statement-breakpoint

CREATE FUNCTION "valid_execution_provider_account"(provider text, identity jsonb) RETURNS boolean AS $$
BEGIN
  IF provider = 'vigilo' THEN RETURN identity IS NULL; END IF;
  IF identity IS NULL OR jsonb_typeof(identity) <> 'object' THEN RETURN false; END IF;
  IF provider = 'google' THEN
    RETURN COALESCE(identity->>'kind' = 'google_project' AND identity ? 'projectId'
      AND jsonb_typeof(identity->'projectId') = 'string'
      AND identity->>'projectId' ~ '^[A-Za-z0-9_-]{1,128}$'
      AND identity - 'kind' - 'projectId' = '{}'::jsonb, false);
  END IF;
  IF provider IN ('vercel','vercel-sandbox') THEN
    RETURN COALESCE(identity->>'kind' = 'vercel_team_project' AND identity ? 'teamId' AND identity ? 'projectId'
      AND jsonb_typeof(identity->'teamId') = 'string' AND jsonb_typeof(identity->'projectId') = 'string'
      AND identity->>'teamId' ~ '^[A-Za-z0-9_-]{1,128}$'
      AND identity->>'projectId' ~ '^[A-Za-z0-9_-]{1,128}$'
      AND identity - 'kind' - 'teamId' - 'projectId' = '{}'::jsonb, false);
  END IF;
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;--> statement-breakpoint

ALTER TABLE "execution_budget_grant" DROP CONSTRAINT "execution_budget_grant_version_check";--> statement-breakpoint
ALTER TABLE "execution_budget_grant" ADD CONSTRAINT "execution_budget_grant_version_check" CHECK ("version" IN (1,2));--> statement-breakpoint
ALTER TABLE "execution_budget_grant" ADD CONSTRAINT "execution_budget_grant_provenance_check" CHECK (
  ("version" = 1 AND "authorized_release_sha" IS NULL AND "authorized_provider_account_identity" IS NULL)
  OR ("version" = 2 AND "scope" = 'account' AND "authorized_release_sha" IS NULL AND "authorized_provider_account_identity" IS NULL)
  OR ("version" = 2 AND "scope" IN ('operation','one_shot')
      AND "repair_run_id" IS NOT NULL AND "github_repository_id" IS NOT NULL AND "base_commit_sha" IS NOT NULL
      AND "authorized_release_sha" IS NOT NULL
      AND "authorized_release_sha" ~ '^[0-9a-f]{40}$'
      AND "valid_execution_provider_account"("provider_id","authorized_provider_account_identity"))
);--> statement-breakpoint
CREATE FUNCTION "guard_execution_budget_grant_insert_provenance"() RETURNS trigger AS $$
BEGIN
  IF NEW."scope" IN ('operation','one_shot') AND NEW."version" <> 2 THEN RAISE EXCEPTION 'execution_authority_mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "execution_budget_grant_insert_provenance_guard" BEFORE INSERT ON "execution_budget_grant" FOR EACH ROW EXECUTE FUNCTION "guard_execution_budget_grant_insert_provenance"();--> statement-breakpoint

ALTER TABLE "external_execution_reservation" DROP CONSTRAINT "external_execution_reservation_version_check";--> statement-breakpoint
ALTER TABLE "external_execution_reservation" ADD CONSTRAINT "external_execution_reservation_version_check" CHECK ("version" IN (1,2));--> statement-breakpoint
ALTER TABLE "external_execution_reservation" ADD CONSTRAINT "external_execution_reservation_provenance_check" CHECK (
  ("version" = 1 AND "executing_release_sha" IS NULL AND "executing_provider_account_identity" IS NULL)
  OR ("version" = 2 AND "repair_run_id" IS NOT NULL AND "github_repository_id" IS NOT NULL AND "base_commit_sha" IS NOT NULL
      AND "executing_release_sha" IS NOT NULL
      AND "executing_release_sha" ~ '^[0-9a-f]{40}$'
      AND "valid_execution_provider_account"("provider_id","executing_provider_account_identity"))
);--> statement-breakpoint

CREATE FUNCTION "guard_repair_run_provenance"() RETURNS trigger AS $$
DECLARE baseline "repository_baseline"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'repair run audit subject is immutable'; END IF;
  IF ROW(OLD."id",OLD."workspace_id",OLD."github_repository_id",OLD."installation_id",OLD."profile_identity",OLD."base_commit_sha",OLD."idempotency_key",OLD."created_at")
     IS DISTINCT FROM ROW(NEW."id",NEW."workspace_id",NEW."github_repository_id",NEW."installation_id",NEW."profile_identity",NEW."base_commit_sha",NEW."idempotency_key",NEW."created_at") THEN
    RAISE EXCEPTION 'repair run authority is immutable';
  END IF;
  IF OLD."baseline_id" IS NOT NULL AND NEW."baseline_id" IS DISTINCT FROM OLD."baseline_id" THEN RAISE EXCEPTION 'repair run baseline is immutable'; END IF;
  IF OLD."baseline_id" IS NULL AND NEW."baseline_id" IS NOT NULL THEN
    IF OLD."state" <> 'baseline_running' OR NEW."state" NOT IN ('ready_for_investigation','baseline_failed','infrastructure_failed','cancelled') THEN
      RAISE EXCEPTION 'repair run baseline transition invalid';
    END IF;
    SELECT * INTO baseline FROM "repository_baseline" WHERE "id" = NEW."baseline_id";
    IF NOT FOUND OR ROW(baseline."workspace_id",baseline."github_repository_id",baseline."installation_id",baseline."profile_identity",baseline."base_commit_sha")
       IS DISTINCT FROM ROW(NEW."workspace_id",NEW."github_repository_id",NEW."installation_id",NEW."profile_identity",NEW."base_commit_sha") THEN
      RAISE EXCEPTION 'repair run baseline authority mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_run_provenance_guard" BEFORE UPDATE OR DELETE ON "repair_run" FOR EACH ROW EXECUTE FUNCTION "guard_repair_run_provenance"();--> statement-breakpoint

CREATE FUNCTION "guard_repository_baseline_provenance"() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'repository baseline evidence is immutable'; END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repository_baseline_provenance_guard" BEFORE UPDATE OR DELETE ON "repository_baseline" FOR EACH ROW EXECUTE FUNCTION "guard_repository_baseline_provenance"();--> statement-breakpoint

CREATE TABLE "repair_run_source_checkpoint" (
  "repair_run_id" text PRIMARY KEY NOT NULL REFERENCES "repair_run"("id") ON DELETE RESTRICT,
  "expected_source_identity" text NOT NULL,
  "reviewed_by" text NOT NULL,
  "plan_identity" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "baseline_id" text REFERENCES "repository_baseline"("id") ON DELETE RESTRICT,
  "observed_source_identity" text,
  "state" text DEFAULT 'pending' NOT NULL,
  "checked_at" timestamp with time zone,
  CONSTRAINT "repair_run_source_checkpoint_hash_check" CHECK ("expected_source_identity" ~ '^[0-9a-f]{64}$' AND "plan_identity" ~ '^[0-9a-f]{64}$' AND ("observed_source_identity" IS NULL OR "observed_source_identity" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "repair_run_source_checkpoint_state_check" CHECK (("state" = 'pending' AND "baseline_id" IS NULL AND "observed_source_identity" IS NULL AND "checked_at" IS NULL) OR ("state" IN ('matched','mismatched','unmeasured') AND "baseline_id" IS NOT NULL AND "checked_at" IS NOT NULL)),
  CONSTRAINT "repair_run_source_checkpoint_reviewer_check" CHECK (char_length("reviewed_by") BETWEEN 1 AND 200)
);--> statement-breakpoint
CREATE INDEX "repair_run_source_checkpoint_baseline_idx" ON "repair_run_source_checkpoint" ("baseline_id");--> statement-breakpoint

CREATE FUNCTION "guard_repair_run_source_checkpoint"() RETURNS trigger AS $$
DECLARE run "repair_run"%ROWTYPE; baseline "repository_baseline"%ROWTYPE; profile "execution_profile"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reviewed source checkpoint is immutable'; END IF;
  SELECT * INTO run FROM "repair_run" WHERE "id" = NEW."repair_run_id" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reviewed source run missing'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF run."state" <> 'created' OR run."baseline_id" IS NOT NULL OR
      EXISTS (SELECT 1 FROM "repair_run_attempt" WHERE "repair_run_id" = run."id") OR
      EXISTS (SELECT 1 FROM "execution_budget_grant" WHERE "repair_run_id" = run."id") THEN
      RAISE EXCEPTION 'reviewed source expectation too late';
    END IF;
    NEW."created_at" := statement_timestamp();
    NEW."state" := 'pending'; NEW."baseline_id" := NULL; NEW."observed_source_identity" := NULL; NEW."checked_at" := NULL;
    RETURN NEW;
  END IF;
  IF OLD."state" <> 'pending' OR OLD."baseline_id" IS NOT NULL OR
     ROW(OLD."repair_run_id",OLD."expected_source_identity",OLD."reviewed_by",OLD."plan_identity",OLD."created_at")
       IS DISTINCT FROM ROW(NEW."repair_run_id",NEW."expected_source_identity",NEW."reviewed_by",NEW."plan_identity",NEW."created_at") OR
     NEW."baseline_id" IS NULL THEN RAISE EXCEPTION 'reviewed source expectation is immutable'; END IF;
  SELECT * INTO baseline FROM "repository_baseline" WHERE "id" = NEW."baseline_id";
  IF NOT FOUND OR run."baseline_id" IS DISTINCT FROM baseline."id" OR
     ROW(baseline."workspace_id",baseline."github_repository_id",baseline."installation_id",baseline."profile_identity",baseline."base_commit_sha")
       IS DISTINCT FROM ROW(run."workspace_id",run."github_repository_id",run."installation_id",run."profile_identity",run."base_commit_sha") THEN
    RAISE EXCEPTION 'reviewed source baseline mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "repair_run_attempt" attempt
      WHERE attempt."repair_run_id" = run."id" AND attempt."expected_baseline_id" = baseline."id"
        AND attempt."baseline_id" = baseline."id" AND attempt."state" IN ('succeeded','customer_failed')) THEN
    RAISE EXCEPTION 'reviewed source baseline attempt mismatch';
  END IF;
  SELECT * INTO profile FROM "execution_profile" WHERE "workspace_id" = run."workspace_id" AND "github_repository_id" = run."github_repository_id" AND "profile_identity" = run."profile_identity";
  NEW."observed_source_identity" := baseline."source_identity_before";
  NEW."state" := CASE
    WHEN baseline."source_identity_before" IS NULL OR baseline."source_identity_after" IS NULL THEN 'unmeasured'
    WHEN baseline."source_identity_before" IS DISTINCT FROM OLD."expected_source_identity" OR baseline."source_identity_after" IS DISTINCT FROM OLD."expected_source_identity" THEN 'mismatched'
    WHEN baseline."evidence_version" <> 1 OR baseline."source_unchanged" IS NOT TRUE OR
      profile."status" IS DISTINCT FROM 'ready' OR profile."test_script" IS DISTINCT FROM 'test' OR
      profile."installation_id" IS DISTINCT FROM run."installation_id" OR
      profile."base_commit_sha" IS DISTINCT FROM run."base_commit_sha" OR
      baseline."credentials_exposure" <> 'absent' OR baseline."network_policy" <> 'deny-all' OR
      baseline."install_status" <> 'completed' OR baseline."install_exit_code" <> 0 OR baseline."install_timed_out" IS NOT FALSE OR
      baseline."cleanup_stop" <> 'confirmed' OR baseline."cleanup_delete" <> 'confirmed' OR baseline."cleanup_lookup" <> 'absent' OR
      baseline."overall_outcome" NOT IN ('baseline_failed','typecheck_failed','build_failed','test_failed') OR
      baseline."execution_outcome" IS DISTINCT FROM baseline."overall_outcome" THEN 'unmeasured'
    ELSE 'matched' END;
  NEW."checked_at" := statement_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "repair_run_source_checkpoint_guard" BEFORE INSERT OR UPDATE OR DELETE ON "repair_run_source_checkpoint" FOR EACH ROW EXECUTE FUNCTION "guard_repair_run_source_checkpoint"();--> statement-breakpoint

ALTER TABLE "operational_worker_heartbeat" DROP CONSTRAINT "operational_worker_heartbeat_release_check";--> statement-breakpoint
ALTER TABLE "operational_worker_heartbeat" ADD CONSTRAINT "operational_worker_heartbeat_release_check" CHECK ("release_sha" ~ '^[0-9a-f]{40}$' AND "expected_schema_version" IN ('0023','0024'));--> statement-breakpoint

CREATE FUNCTION "guard_external_execution_reservation_provenance"() RETURNS trigger AS $$
DECLARE g "execution_budget_grant"%ROWTYPE; subject_run "repair_run"%ROWTYPE;
BEGIN
  SELECT * INTO g FROM "execution_budget_grant" WHERE "id" = NEW."grant_id";
  IF NOT FOUND OR g."version" <> 2 OR NEW."version" <> 2 OR
     NEW."executing_release_sha" IS DISTINCT FROM g."authorized_release_sha" OR
     NEW."executing_provider_account_identity" IS DISTINCT FROM g."authorized_provider_account_identity" THEN
    RAISE EXCEPTION 'execution_authority_mismatch';
  END IF;
  SELECT * INTO subject_run FROM "repair_run" WHERE "id" = NEW."repair_run_id";
  IF NOT FOUND OR ROW(subject_run."workspace_id",subject_run."github_repository_id",subject_run."base_commit_sha")
     IS DISTINCT FROM ROW(NEW."workspace_id",NEW."github_repository_id",NEW."base_commit_sha") THEN
    RAISE EXCEPTION 'execution_authority_mismatch';
  END IF;
  IF NEW."operation_category" IN ('gemini_investigation','gemini_candidate_generation') AND
     EXISTS (SELECT 1 FROM "repair_run_source_checkpoint" c WHERE c."repair_run_id" = subject_run."id" AND c."state" <> 'matched') THEN
    RAISE EXCEPTION 'execution_authority_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "external_execution_reservation_provenance_guard" BEFORE INSERT ON "external_execution_reservation" FOR EACH ROW EXECUTE FUNCTION "guard_external_execution_reservation_provenance"();--> statement-breakpoint

CREATE FUNCTION "guard_external_execution_attempt_provenance"() RETURNS trigger AS $$
DECLARE reservation "external_execution_reservation"%ROWTYPE; g "execution_budget_grant"%ROWTYPE;
BEGIN
  IF NEW."event_type" <> 'attempt_started' THEN RETURN NEW; END IF;
  SELECT * INTO reservation FROM "external_execution_reservation" WHERE "id" = NEW."reservation_id";
  SELECT * INTO g FROM "execution_budget_grant" WHERE "id" = reservation."grant_id";
  IF NOT FOUND OR reservation."version" <> 2 OR g."version" <> 2 OR
     reservation."executing_release_sha" IS DISTINCT FROM g."authorized_release_sha" OR
     reservation."executing_provider_account_identity" IS DISTINCT FROM g."authorized_provider_account_identity" OR
     EXISTS (SELECT 1 FROM "execution_budget_grant_revocation" v WHERE v."grant_id" IN (reservation."grant_id",reservation."account_grant_id")) OR
     EXISTS (SELECT 1 FROM "repair_run_source_checkpoint" c WHERE c."repair_run_id" = reservation."repair_run_id" AND c."state" <> 'matched'
              AND reservation."operation_category" IN ('gemini_investigation','gemini_candidate_generation')) THEN
    RAISE EXCEPTION 'execution_authority_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "external_execution_event_provenance_guard" BEFORE INSERT ON "external_execution_event" FOR EACH ROW EXECUTE FUNCTION "guard_external_execution_attempt_provenance"();--> statement-breakpoint
