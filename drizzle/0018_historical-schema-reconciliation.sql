CREATE TEMP TABLE "vigilo_reconcile_cleanup_original" (
	"cleanup_stop" text,
	"cleanup_delete" text,
	"cleanup_lookup" text,
	CONSTRAINT "expected_cleanup" CHECK (("cleanup_stop" is null or "cleanup_stop" in ('confirmed','failed','not_needed')) and ("cleanup_delete" is null or "cleanup_delete" in ('confirmed','failed','not_needed')) and ("cleanup_lookup" is null or "cleanup_lookup" in ('absent','still_present','unconfirmed','not_run')))
) ON COMMIT DROP;
--> statement-breakpoint
CREATE TEMP TABLE "vigilo_reconcile_cleanup_corrected" (
	"cleanup_stop" text,
	"cleanup_delete" text,
	"cleanup_lookup" text,
	CONSTRAINT "expected_cleanup" CHECK (("cleanup_stop" is null or "cleanup_stop" in ('confirmed','failed','not_needed')) and ("cleanup_delete" is null or "cleanup_delete" in ('confirmed','failed','not_needed')) and ("cleanup_lookup" is null or "cleanup_lookup" in ('absent','still_present','unconfirmed','unconfirmed_after_create_failure','not_run')))
) ON COMMIT DROP;
--> statement-breakpoint
CREATE TEMP TABLE "vigilo_reconcile_ai_usage_original" (
	"input_tokens" integer,
	"output_tokens" integer,
	"tool_call_count" integer,
	"model_turn_count" integer,
	CONSTRAINT "expected_usage" CHECK ("input_tokens" between 0 and 1000000 and "output_tokens" between 0 and 100000 and "tool_call_count" between 0 and 6 and "model_turn_count" between 0 and 8)
) ON COMMIT DROP;
--> statement-breakpoint
CREATE TEMP TABLE "vigilo_reconcile_ai_usage_corrected" (
	"input_tokens" integer,
	"output_tokens" integer,
	"tool_call_count" integer,
	"model_turn_count" integer,
	CONSTRAINT "expected_usage" CHECK ("input_tokens" between 0 and 1000000 and "output_tokens" between 0 and 100000 and "tool_call_count" between 0 and 20 and "model_turn_count" between 0 and 8)
) ON COMMIT DROP;
--> statement-breakpoint
CREATE TEMP TABLE "vigilo_reconcile_repair_run_index" (
	"workspace_id" text,
	"github_repository_id" bigint,
	"installation_id" bigint,
	"profile_identity" text,
	"base_commit_sha" text,
	"state" text
) ON COMMIT DROP;
--> statement-breakpoint
CREATE UNIQUE INDEX "vigilo_expected_repair_run_active" ON "vigilo_reconcile_repair_run_index" ("workspace_id","github_repository_id","installation_id","profile_identity","base_commit_sha") WHERE "state" in ('created','baseline_running');
--> statement-breakpoint
CREATE TEMP TABLE "vigilo_reconcile_verification_index" (
	"candidate_id" text,
	"state" text
) ON COMMIT DROP;
--> statement-breakpoint
CREATE UNIQUE INDEX "vigilo_expected_verification_active" ON "vigilo_reconcile_verification_index" ("candidate_id") WHERE "state" in ('created','queued','verifying');
--> statement-breakpoint
CREATE FUNCTION pg_temp."vigilo_guard_generation_original"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI candidate generations are durable'; END IF;
	IF OLD."state" IN ('frozen','abstained','failed','cancelled') THEN RAISE EXCEPTION 'terminal AI candidate generations are immutable'; END IF;
	IF OLD."state" IS DISTINCT FROM NEW."state" AND NOT ((OLD."state" = 'created' AND NEW."state" IN ('queued','cancelled')) OR (OLD."state" = 'queued' AND NEW."state" IN ('generating','cancelled')) OR (OLD."state" = 'generating' AND NEW."state" IN ('frozen','abstained','failed','cancelled'))) THEN RAISE EXCEPTION 'invalid AI candidate generation transition'; END IF;
	IF ROW(OLD."ai_investigation_id",OLD."investigation_id",OLD."repair_run_id",OLD."baseline_id",OLD."workspace_id",OLD."github_repository_id",OLD."installation_id",OLD."base_commit_sha",OLD."profile_identity",OLD."provider_id",OLD."model_id",OLD."protocol_version",OLD."idempotency_key",OLD."created_at") IS DISTINCT FROM ROW(NEW."ai_investigation_id",NEW."investigation_id",NEW."repair_run_id",NEW."baseline_id",NEW."workspace_id",NEW."github_repository_id",NEW."installation_id",NEW."base_commit_sha",NEW."profile_identity",NEW."provider_id",NEW."model_id",NEW."protocol_version",NEW."idempotency_key",NEW."created_at") THEN RAISE EXCEPTION 'AI candidate generation authority is immutable'; END IF;
	IF OLD."queued_at" IS DISTINCT FROM NEW."queued_at" AND NOT (OLD."state" = 'created' AND NEW."state" = 'queued' AND OLD."queued_at" IS NULL AND NEW."queued_at" IS NOT NULL) THEN RAISE EXCEPTION 'AI candidate generation queue time is immutable'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION pg_temp."vigilo_guard_generation_corrected"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI candidate generations are durable'; END IF;
	IF OLD."state" IN ('frozen','abstained','failed','cancelled') THEN RAISE EXCEPTION 'terminal AI candidate generations are immutable'; END IF;
	IF OLD."state" IS DISTINCT FROM NEW."state" AND NOT ((OLD."state" = 'created' AND NEW."state" IN ('queued','cancelled')) OR (OLD."state" = 'queued' AND NEW."state" IN ('generating','cancelled')) OR (OLD."state" = 'generating' AND NEW."state" IN ('frozen','abstained','failed','cancelled'))) THEN RAISE EXCEPTION 'invalid AI candidate generation transition'; END IF;
	IF ROW(OLD."ai_investigation_id",OLD."execution_ordinal",OLD."investigation_id",OLD."repair_run_id",OLD."baseline_id",OLD."workspace_id",OLD."github_repository_id",OLD."installation_id",OLD."base_commit_sha",OLD."profile_identity",OLD."provider_id",OLD."model_id",OLD."protocol_version",OLD."idempotency_key",OLD."created_at") IS DISTINCT FROM ROW(NEW."ai_investigation_id",NEW."execution_ordinal",NEW."investigation_id",NEW."repair_run_id",NEW."baseline_id",NEW."workspace_id",NEW."github_repository_id",NEW."installation_id",NEW."base_commit_sha",NEW."profile_identity",NEW."provider_id",NEW."model_id",NEW."protocol_version",NEW."idempotency_key",NEW."created_at") THEN RAISE EXCEPTION 'AI candidate generation authority is immutable'; END IF;
	IF OLD."queued_at" IS DISTINCT FROM NEW."queued_at" AND NOT (OLD."state" = 'created' AND NEW."state" = 'queued' AND OLD."queued_at" IS NULL AND NEW."queued_at" IS NOT NULL) THEN RAISE EXCEPTION 'AI candidate generation queue time is immutable'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
LOCK TABLE "repository_baseline", "repair_run", "repair_run_attempt", "repair_candidate", "repair_candidate_file", "repair_candidate_event", "candidate_verification", "ai_investigation", "ai_candidate_generation" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $reconciliation_preflight$
DECLARE
	baseline_present integer := 0;
	repair_run_index_count integer;
	cleanup_actual text;
	cleanup_original text;
	cleanup_corrected text;
	candidate_cascade integer := 0;
	candidate_restrict integer := 0;
	candidate_unique_count integer;
	candidate_named_unique_count integer;
	verification_index_count integer;
	usage_actual text;
	usage_original text;
	usage_corrected text;
	guard_actual text;
	guard_original text;
	guard_corrected text;
	guard_oid oid;
	fk record;
	fk_count integer;
	fk_action "char";
	fk_update_action "char";
	fk_columns text[];
	fk_reference_columns text[];
	expected_repair_run_predicate text;
	expected_verification_predicate text;
BEGIN
	SELECT pg_get_expr(i.indpred, i.indrelid, true) INTO expected_repair_run_predicate
	FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
	WHERE c.relnamespace = pg_my_temp_schema() AND c.relname = 'vigilo_expected_repair_run_active';
	SELECT pg_get_expr(i.indpred, i.indrelid, true) INTO expected_verification_predicate
	FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
	WHERE c.relnamespace = pg_my_temp_schema() AND c.relname = 'vigilo_expected_verification_active';

	FOR fk IN SELECT * FROM (VALUES
		('repository_baseline_github_repository_id_repository_github_repository_id_fk', 'github_repository_id', 'repository', 'github_repository_id'),
		('repository_baseline_installation_id_github_installation_installation_id_fk', 'installation_id', 'github_installation', 'installation_id')
	) AS expected(name, column_name, reference_table, reference_column)
	LOOP
		SELECT count(*) INTO fk_count
		FROM pg_constraint c
		WHERE c.conrelid = 'repository_baseline'::regclass AND c.contype = 'f'
			AND (SELECT array_agg(a.attname::text ORDER BY key.ordinality)
				FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality)
				JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum) = ARRAY[fk.column_name];
		IF fk_count = 0 THEN
			IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'repository_baseline'::regclass AND c.conname = fk.name::name) THEN
				RAISE EXCEPTION 'historical_reconciliation_unexpected_0006_baseline_fk';
			END IF;
			CONTINUE;
		END IF;
		IF fk_count <> 1 THEN
			RAISE EXCEPTION 'historical_reconciliation_unexpected_0006_baseline_fk';
		END IF;
		SELECT c.confdeltype, c.confupdtype,
			(SELECT array_agg(a.attname::text ORDER BY key.ordinality) FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum),
			(SELECT array_agg(a.attname::text ORDER BY key.ordinality) FROM unnest(c.confkey) WITH ORDINALITY AS key(attnum, ordinality) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = key.attnum)
		INTO fk_action, fk_update_action, fk_columns, fk_reference_columns
		FROM pg_constraint c
		WHERE c.conrelid = 'repository_baseline'::regclass AND c.conname = fk.name::name
			AND c.confrelid = to_regclass(fk.reference_table) AND c.contype = 'f' AND c.convalidated AND NOT c.condeferrable;
		IF NOT FOUND OR fk_action <> 'c' OR fk_update_action <> 'a' OR fk_columns <> ARRAY[fk.column_name] OR fk_reference_columns <> ARRAY[fk.reference_column] THEN
			RAISE EXCEPTION 'historical_reconciliation_unexpected_0006_baseline_fk';
		END IF;
		baseline_present := baseline_present + 1;
	END LOOP;

	SELECT count(*) INTO repair_run_index_count
	FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
	WHERE i.indrelid = 'repair_run'::regclass AND i.indisunique AND i.indisvalid AND i.indisready
		AND (SELECT array_agg(a.attname::text ORDER BY key.ordinality)
			FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
			JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
			WHERE key.ordinality <= i.indnkeyatts) = ARRAY['workspace_id','github_repository_id','installation_id','profile_identity','base_commit_sha']
		AND pg_get_expr(i.indpred, i.indrelid, true) = expected_repair_run_predicate;
	IF NOT ((baseline_present = 2 AND repair_run_index_count = 0 AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'repair_run_active_identity_unique')) OR
		(baseline_present = 0 AND repair_run_index_count = 1 AND EXISTS (
			SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
			WHERE i.indrelid = 'repair_run'::regclass AND c.relname = 'repair_run_active_identity_unique' AND i.indisunique AND i.indisvalid AND i.indisready
				AND (SELECT array_agg(a.attname::text ORDER BY key.ordinality)
					FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
					JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
					WHERE key.ordinality <= i.indnkeyatts) = ARRAY['workspace_id','github_repository_id','installation_id','profile_identity','base_commit_sha']
				AND pg_get_expr(i.indpred, i.indrelid, true) = expected_repair_run_predicate
		))) THEN
		RAISE EXCEPTION 'historical_reconciliation_unexpected_0006_state';
	END IF;

	SELECT pg_get_constraintdef(oid, true) INTO cleanup_actual FROM pg_constraint WHERE conrelid = 'repair_run_attempt'::regclass AND conname = 'repair_run_attempt_cleanup_check';
	SELECT pg_get_constraintdef(oid, true) INTO cleanup_original FROM pg_constraint WHERE conrelid = 'vigilo_reconcile_cleanup_original'::regclass AND conname = 'expected_cleanup';
	SELECT pg_get_constraintdef(oid, true) INTO cleanup_corrected FROM pg_constraint WHERE conrelid = 'vigilo_reconcile_cleanup_corrected'::regclass AND conname = 'expected_cleanup';
	IF cleanup_actual IS NULL OR cleanup_actual NOT IN (cleanup_original, cleanup_corrected) THEN
		RAISE EXCEPTION 'historical_reconciliation_unexpected_0007_cleanup_check';
	END IF;

	FOR fk IN SELECT * FROM (VALUES
		('repair_candidate_investigation_id_investigation_id_fk', 'repair_candidate', 'investigation_id', 'investigation', 'id'),
		('repair_candidate_repair_run_id_repair_run_id_fk', 'repair_candidate', 'repair_run_id', 'repair_run', 'id'),
		('repair_candidate_workspace_id_workspace_id_fk', 'repair_candidate', 'workspace_id', 'workspace', 'id'),
		('repair_candidate_file_candidate_id_repair_candidate_id_fk', 'repair_candidate_file', 'candidate_id', 'repair_candidate', 'id'),
		('repair_candidate_event_candidate_id_repair_candidate_id_fk', 'repair_candidate_event', 'candidate_id', 'repair_candidate', 'id'),
		('repair_candidate_event_workspace_id_workspace_id_fk', 'repair_candidate_event', 'workspace_id', 'workspace', 'id')
	) AS expected(name, table_name, column_name, reference_table, reference_column)
	LOOP
		SELECT count(*) INTO fk_count
		FROM pg_constraint c
		WHERE c.conrelid = to_regclass(fk.table_name) AND c.contype = 'f'
			AND (SELECT array_agg(a.attname::text ORDER BY key.ordinality)
				FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality)
				JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum) = ARRAY[fk.column_name];
		IF fk_count <> 1 THEN RAISE EXCEPTION 'historical_reconciliation_unexpected_0009_candidate_fk:%', fk.name; END IF;
		SELECT c.confdeltype, c.confupdtype,
			(SELECT array_agg(a.attname::text ORDER BY key.ordinality) FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum),
			(SELECT array_agg(a.attname::text ORDER BY key.ordinality) FROM unnest(c.confkey) WITH ORDINALITY AS key(attnum, ordinality) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = key.attnum)
		INTO fk_action, fk_update_action, fk_columns, fk_reference_columns
		FROM pg_constraint c
		WHERE c.conrelid = to_regclass(fk.table_name) AND c.conname = fk.name::name AND c.confrelid = to_regclass(fk.reference_table)
			AND c.contype = 'f' AND c.convalidated AND NOT c.condeferrable;
		IF NOT FOUND OR fk_action NOT IN ('c','r') OR fk_update_action <> 'a' OR fk_columns <> ARRAY[fk.column_name] OR fk_reference_columns <> ARRAY[fk.reference_column] THEN
			RAISE EXCEPTION 'historical_reconciliation_unexpected_0009_candidate_fk:%', fk.name;
		END IF;
		IF fk_action = 'c' THEN candidate_cascade := candidate_cascade + 1; ELSE candidate_restrict := candidate_restrict + 1; END IF;
	END LOOP;
	IF NOT ((candidate_cascade = 6 AND candidate_restrict = 0) OR (candidate_cascade = 0 AND candidate_restrict = 6)) THEN
		RAISE EXCEPTION 'historical_reconciliation_unexpected_0009_mixed_fk_state';
	END IF;

	SELECT count(*) INTO candidate_unique_count
	FROM pg_constraint c
	WHERE c.conrelid = 'candidate_verification'::regclass AND c.contype = 'u'
		AND (SELECT array_agg(a.attname::text ORDER BY key.ordinality)
			FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality)
			JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum) = ARRAY['candidate_id'];
	SELECT count(*) INTO candidate_named_unique_count FROM pg_constraint WHERE conrelid = 'candidate_verification'::regclass AND conname = 'candidate_verification_candidate_id_key';
	IF NOT ((candidate_unique_count = 1 AND candidate_named_unique_count = 1) OR (candidate_unique_count = 0 AND candidate_named_unique_count = 0)) THEN
		RAISE EXCEPTION 'historical_reconciliation_unexpected_0010_candidate_unique';
	END IF;
	SELECT count(*) INTO verification_index_count
	FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
	WHERE i.indrelid = 'candidate_verification'::regclass AND i.indisunique AND i.indisvalid AND i.indisready
		AND (SELECT array_agg(a.attname::text ORDER BY key.ordinality)
			FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
			JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
			WHERE key.ordinality <= i.indnkeyatts) = ARRAY['candidate_id']
		AND pg_get_expr(i.indpred, i.indrelid, true) = expected_verification_predicate;
	IF verification_index_count <> 1 OR NOT EXISTS (
		SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
		WHERE i.indrelid = 'candidate_verification'::regclass AND c.relname = 'candidate_verification_active_candidate_unique'
			AND i.indisunique AND i.indisvalid AND i.indisready
			AND (SELECT array_agg(a.attname::text ORDER BY key.ordinality)
				FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
				JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
				WHERE key.ordinality <= i.indnkeyatts) = ARRAY['candidate_id']
			AND pg_get_expr(i.indpred, i.indrelid, true) = expected_verification_predicate
	) THEN RAISE EXCEPTION 'historical_reconciliation_unexpected_0010_active_index'; END IF;

	SELECT pg_get_constraintdef(oid, true) INTO usage_actual FROM pg_constraint WHERE conrelid = 'ai_investigation'::regclass AND conname = 'ai_investigation_usage_check';
	SELECT pg_get_constraintdef(oid, true) INTO usage_original FROM pg_constraint WHERE conrelid = 'vigilo_reconcile_ai_usage_original'::regclass AND conname = 'expected_usage';
	SELECT pg_get_constraintdef(oid, true) INTO usage_corrected FROM pg_constraint WHERE conrelid = 'vigilo_reconcile_ai_usage_corrected'::regclass AND conname = 'expected_usage';
	IF usage_actual IS NULL OR usage_actual NOT IN (usage_original, usage_corrected) THEN
		RAISE EXCEPTION 'historical_reconciliation_unexpected_0011_usage_check';
	END IF;

	SELECT p.oid, regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g') INTO guard_oid, guard_actual
	FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
	WHERE n.nspname = 'public' AND p.proname = 'guard_ai_candidate_generation_update' AND p.pronargs = 0 AND p.prorettype = 'trigger'::regtype;
	SELECT regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g') INTO guard_original FROM pg_proc p WHERE p.oid = 'pg_temp.vigilo_guard_generation_original()'::regprocedure;
	SELECT regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g') INTO guard_corrected FROM pg_proc p WHERE p.oid = 'pg_temp.vigilo_guard_generation_corrected()'::regprocedure;
	IF guard_oid IS NULL OR guard_actual NOT IN (guard_original, guard_corrected) OR NOT EXISTS (
		SELECT 1 FROM pg_trigger WHERE tgrelid = 'ai_candidate_generation'::regclass AND tgname = 'ai_candidate_generation_update_guard' AND NOT tgisinternal AND tgenabled <> 'D' AND tgfoid = guard_oid
	) THEN
		RAISE EXCEPTION 'historical_reconciliation_unexpected_0017_authority_guard';
	END IF;
END;
$reconciliation_preflight$;
--> statement-breakpoint
DO $reconciliation_apply$
DECLARE
	cleanup_actual text;
	cleanup_original text;
	usage_actual text;
	usage_original text;
	guard_actual text;
	guard_original text;
	fk record;
	fk_action "char";
BEGIN
	IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'repository_baseline'::regclass AND conname = 'repository_baseline_github_repository_id_repository_github_repository_id_fk') THEN
		ALTER TABLE "repository_baseline" DROP CONSTRAINT "repository_baseline_github_repository_id_repository_github_repository_id_fk";
		ALTER TABLE "repository_baseline" DROP CONSTRAINT "repository_baseline_installation_id_github_installation_installation_id_fk";
		CREATE UNIQUE INDEX "repair_run_active_identity_unique" ON "repair_run" ("workspace_id","github_repository_id","installation_id","profile_identity","base_commit_sha") WHERE "state" in ('created','baseline_running');
	END IF;

	SELECT pg_get_constraintdef(oid, true) INTO cleanup_actual FROM pg_constraint WHERE conrelid = 'repair_run_attempt'::regclass AND conname = 'repair_run_attempt_cleanup_check';
	SELECT pg_get_constraintdef(oid, true) INTO cleanup_original FROM pg_constraint WHERE conrelid = 'vigilo_reconcile_cleanup_original'::regclass AND conname = 'expected_cleanup';
	IF cleanup_actual = cleanup_original THEN
		ALTER TABLE "repair_run_attempt" DROP CONSTRAINT "repair_run_attempt_cleanup_check";
		ALTER TABLE "repair_run_attempt" ADD CONSTRAINT "repair_run_attempt_cleanup_check" CHECK (("cleanup_stop" is null or "cleanup_stop" in ('confirmed','failed','not_needed')) and ("cleanup_delete" is null or "cleanup_delete" in ('confirmed','failed','not_needed')) and ("cleanup_lookup" is null or "cleanup_lookup" in ('absent','still_present','unconfirmed','unconfirmed_after_create_failure','not_run')));
	END IF;

	FOR fk IN SELECT * FROM (VALUES
		('repair_candidate_investigation_id_investigation_id_fk', 'repair_candidate', 'investigation_id', 'investigation', 'id'),
		('repair_candidate_repair_run_id_repair_run_id_fk', 'repair_candidate', 'repair_run_id', 'repair_run', 'id'),
		('repair_candidate_workspace_id_workspace_id_fk', 'repair_candidate', 'workspace_id', 'workspace', 'id'),
		('repair_candidate_file_candidate_id_repair_candidate_id_fk', 'repair_candidate_file', 'candidate_id', 'repair_candidate', 'id'),
		('repair_candidate_event_candidate_id_repair_candidate_id_fk', 'repair_candidate_event', 'candidate_id', 'repair_candidate', 'id'),
		('repair_candidate_event_workspace_id_workspace_id_fk', 'repair_candidate_event', 'workspace_id', 'workspace', 'id')
	) AS expected(name, table_name, column_name, reference_table, reference_column)
	LOOP
		SELECT c.confdeltype INTO fk_action FROM pg_constraint c WHERE c.conrelid = to_regclass(fk.table_name) AND c.conname = fk.name::name;
		IF fk_action = 'c' THEN
			EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', fk.table_name, fk.name);
			EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I (%I) ON DELETE RESTRICT ON UPDATE NO ACTION', fk.table_name, fk.name, fk.column_name, fk.reference_table, fk.reference_column);
		END IF;
	END LOOP;

	IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'candidate_verification'::regclass AND conname = 'candidate_verification_candidate_id_key') THEN
		ALTER TABLE "candidate_verification" DROP CONSTRAINT "candidate_verification_candidate_id_key";
	END IF;

	SELECT pg_get_constraintdef(oid, true) INTO usage_actual FROM pg_constraint WHERE conrelid = 'ai_investigation'::regclass AND conname = 'ai_investigation_usage_check';
	SELECT pg_get_constraintdef(oid, true) INTO usage_original FROM pg_constraint WHERE conrelid = 'vigilo_reconcile_ai_usage_original'::regclass AND conname = 'expected_usage';
	IF usage_actual = usage_original THEN
		ALTER TABLE "ai_investigation" DROP CONSTRAINT "ai_investigation_usage_check";
		ALTER TABLE "ai_investigation" ADD CONSTRAINT "ai_investigation_usage_check" CHECK ("input_tokens" between 0 and 1000000 and "output_tokens" between 0 and 100000 and "tool_call_count" between 0 and 20 and "model_turn_count" between 0 and 8);
	END IF;

	SELECT regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g') INTO guard_actual FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'guard_ai_candidate_generation_update' AND p.pronargs = 0;
	SELECT regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g') INTO guard_original FROM pg_proc p WHERE p.oid = 'pg_temp.vigilo_guard_generation_original()'::regprocedure;
	IF guard_actual = guard_original THEN
		CREATE OR REPLACE FUNCTION "guard_ai_candidate_generation_update"() RETURNS trigger AS $corrected_guard$
		BEGIN
			IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI candidate generations are durable'; END IF;
			IF OLD."state" IN ('frozen','abstained','failed','cancelled') THEN RAISE EXCEPTION 'terminal AI candidate generations are immutable'; END IF;
			IF OLD."state" IS DISTINCT FROM NEW."state" AND NOT ((OLD."state" = 'created' AND NEW."state" IN ('queued','cancelled')) OR (OLD."state" = 'queued' AND NEW."state" IN ('generating','cancelled')) OR (OLD."state" = 'generating' AND NEW."state" IN ('frozen','abstained','failed','cancelled'))) THEN RAISE EXCEPTION 'invalid AI candidate generation transition'; END IF;
			IF ROW(OLD."ai_investigation_id",OLD."execution_ordinal",OLD."investigation_id",OLD."repair_run_id",OLD."baseline_id",OLD."workspace_id",OLD."github_repository_id",OLD."installation_id",OLD."base_commit_sha",OLD."profile_identity",OLD."provider_id",OLD."model_id",OLD."protocol_version",OLD."idempotency_key",OLD."created_at") IS DISTINCT FROM ROW(NEW."ai_investigation_id",NEW."execution_ordinal",NEW."investigation_id",NEW."repair_run_id",NEW."baseline_id",NEW."workspace_id",NEW."github_repository_id",NEW."installation_id",NEW."base_commit_sha",NEW."profile_identity",NEW."provider_id",NEW."model_id",NEW."protocol_version",NEW."idempotency_key",NEW."created_at") THEN RAISE EXCEPTION 'AI candidate generation authority is immutable'; END IF;
			IF OLD."queued_at" IS DISTINCT FROM NEW."queued_at" AND NOT (OLD."state" = 'created' AND NEW."state" = 'queued' AND OLD."queued_at" IS NULL AND NEW."queued_at" IS NOT NULL) THEN RAISE EXCEPTION 'AI candidate generation queue time is immutable'; END IF;
			RETURN NEW;
		END;
		$corrected_guard$ LANGUAGE plpgsql;
	END IF;
END;
$reconciliation_apply$;
--> statement-breakpoint
DROP FUNCTION pg_temp."vigilo_guard_generation_original"();
--> statement-breakpoint
DROP FUNCTION pg_temp."vigilo_guard_generation_corrected"();
--> statement-breakpoint
DROP TABLE "vigilo_reconcile_cleanup_original", "vigilo_reconcile_cleanup_corrected", "vigilo_reconcile_ai_usage_original", "vigilo_reconcile_ai_usage_corrected", "vigilo_reconcile_repair_run_index", "vigilo_reconcile_verification_index";
