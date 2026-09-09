CREATE TABLE "repository_baseline" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"evidence_version" integer NOT NULL,
	"profile_identity" text NOT NULL,
	"base_commit_sha" text NOT NULL,
	"archive_sha256" text NOT NULL,
	"sandbox_name" text NOT NULL,
	"sandbox_session_id" text,
	"source_identity_before" text,
	"source_identity_after" text,
	"source_unchanged" boolean,
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
	"execution_outcome" text NOT NULL,
	"overall_outcome" text NOT NULL,
	"cleanup_stop" text NOT NULL,
	"cleanup_delete" text NOT NULL,
	"cleanup_lookup" text NOT NULL,
	"error_phase" text,
	"error_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	CONSTRAINT "repository_baseline_version_check" CHECK ("repository_baseline"."evidence_version" = 1),
	CONSTRAINT "repository_baseline_commit_check" CHECK ("repository_baseline"."base_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "repository_baseline_hashes_check" CHECK ("repository_baseline"."profile_identity" ~ '^[0-9a-f]{64}$' and "repository_baseline"."archive_sha256" ~ '^[0-9a-f]{64}$' and ("repository_baseline"."source_identity_before" is null or "repository_baseline"."source_identity_before" ~ '^[0-9a-f]{64}$') and ("repository_baseline"."source_identity_after" is null or "repository_baseline"."source_identity_after" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "repository_baseline_credentials_check" CHECK ("repository_baseline"."credentials_exposure" in ('absent', 'present', 'not_checked')),
	CONSTRAINT "repository_baseline_network_check" CHECK ("repository_baseline"."network_policy" in ('deny-all', 'unconfirmed')),
	CONSTRAINT "repository_baseline_phase_status_check" CHECK ("repository_baseline"."install_status" in ('not_run','completed','failed','timed_out') and ("repository_baseline"."typecheck_status" is null or "repository_baseline"."typecheck_status" in ('not_run','completed','failed','timed_out')) and ("repository_baseline"."build_status" is null or "repository_baseline"."build_status" in ('not_run','completed','failed','timed_out')) and "repository_baseline"."test_status" in ('not_run','completed','failed','timed_out')),
	CONSTRAINT "repository_baseline_outcome_check" CHECK ("repository_baseline"."execution_outcome" in ('baseline_passed','baseline_failed','installation_failed','typecheck_failed','build_failed','test_failed','timed_out','cancelled','infrastructure_failed','cleanup_failed') and "repository_baseline"."overall_outcome" in ('baseline_passed','baseline_failed','installation_failed','typecheck_failed','build_failed','test_failed','timed_out','cancelled','infrastructure_failed','cleanup_failed')),
	CONSTRAINT "repository_baseline_clean_success_check" CHECK ("repository_baseline"."overall_outcome" <> 'baseline_passed' or ("repository_baseline"."execution_outcome" = 'baseline_passed' and "repository_baseline"."credentials_exposure" = 'absent' and "repository_baseline"."network_policy" = 'deny-all' and "repository_baseline"."source_identity_before" = "repository_baseline"."source_identity_after" and "repository_baseline"."source_unchanged" is true and "repository_baseline"."install_status" = 'completed' and "repository_baseline"."install_exit_code" = 0 and "repository_baseline"."install_timed_out" is false and ("repository_baseline"."typecheck_status" is null or ("repository_baseline"."typecheck_status" = 'completed' and "repository_baseline"."typecheck_exit_code" = 0 and "repository_baseline"."typecheck_timed_out" is false)) and ("repository_baseline"."build_status" is null or ("repository_baseline"."build_status" = 'completed' and "repository_baseline"."build_exit_code" = 0 and "repository_baseline"."build_timed_out" is false)) and "repository_baseline"."test_status" = 'completed' and "repository_baseline"."test_exit_code" = 0 and "repository_baseline"."test_timed_out" is false and "repository_baseline"."cleanup_stop" = 'confirmed' and "repository_baseline"."cleanup_delete" = 'confirmed' and "repository_baseline"."cleanup_lookup" = 'absent' and "repository_baseline"."error_code" is null)),
	CONSTRAINT "repository_baseline_duration_check" CHECK ("repository_baseline"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "repository_baseline" ADD CONSTRAINT "repository_baseline_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_baseline" ADD CONSTRAINT "repository_baseline_github_repository_id_repository_github_repository_id_fk" FOREIGN KEY ("github_repository_id") REFERENCES "public"."repository"("github_repository_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_baseline" ADD CONSTRAINT "repository_baseline_installation_id_github_installation_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installation"("installation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "repository_baseline_workspace_id_idx" ON "repository_baseline" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "repository_baseline_repository_id_idx" ON "repository_baseline" USING btree ("github_repository_id");
