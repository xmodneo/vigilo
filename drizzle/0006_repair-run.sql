ALTER TABLE "repository_baseline" DROP CONSTRAINT "repository_baseline_github_repository_id_repository_github_repository_id_fk";
--> statement-breakpoint
ALTER TABLE "repository_baseline" DROP CONSTRAINT "repository_baseline_installation_id_github_installation_installation_id_fk";
--> statement-breakpoint
CREATE TABLE "repair_run" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"profile_identity" text NOT NULL,
	"base_commit_sha" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text NOT NULL,
	"baseline_id" text,
	"baseline_outcome" text,
	"failure_classification" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"baseline_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_run_baseline_id_unique" UNIQUE("baseline_id"),
	CONSTRAINT "repair_run_commit_check" CHECK ("repair_run"."base_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "repair_run_profile_identity_check" CHECK ("repair_run"."profile_identity" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "repair_run_idempotency_check" CHECK ("repair_run"."idempotency_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_run_state_check" CHECK ("repair_run"."state" in ('created','baseline_running','ready_for_investigation','baseline_failed','infrastructure_failed','cancelled')),
	CONSTRAINT "repair_run_baseline_outcome_check" CHECK ("repair_run"."baseline_outcome" is null or "repair_run"."baseline_outcome" in ('baseline_passed','baseline_failed','installation_failed','typecheck_failed','build_failed','test_failed','timed_out','cancelled','infrastructure_failed','cleanup_failed')),
	CONSTRAINT "repair_run_failure_facts_check" CHECK (("repair_run"."failure_classification" is null or "repair_run"."failure_classification" in ('customer_baseline_failure','infrastructure_failure','cancelled')) and ("repair_run"."failure_code" is null or "repair_run"."failure_code" ~ '^[a-z_]{1,64}$')),
	CONSTRAINT "repair_run_state_facts_check" CHECK (("repair_run"."state" = 'created' and "repair_run"."baseline_started_at" is null and "repair_run"."completed_at" is null and "repair_run"."baseline_id" is null and "repair_run"."baseline_outcome" is null) or ("repair_run"."state" = 'baseline_running' and "repair_run"."baseline_started_at" is not null and "repair_run"."completed_at" is null and "repair_run"."baseline_id" is null and "repair_run"."baseline_outcome" is null) or ("repair_run"."state" = 'ready_for_investigation' and "repair_run"."baseline_started_at" is not null and "repair_run"."completed_at" is not null and "repair_run"."baseline_id" is not null and "repair_run"."baseline_outcome" = 'baseline_passed' and "repair_run"."failure_classification" is null and "repair_run"."failure_code" is null) or ("repair_run"."state" = 'baseline_failed' and "repair_run"."baseline_started_at" is not null and "repair_run"."completed_at" is not null and "repair_run"."baseline_id" is not null and "repair_run"."baseline_outcome" in ('baseline_failed','typecheck_failed','build_failed','test_failed') and "repair_run"."failure_classification" = 'customer_baseline_failure') or ("repair_run"."state" = 'infrastructure_failed' and "repair_run"."baseline_started_at" is not null and "repair_run"."completed_at" is not null and "repair_run"."failure_classification" = 'infrastructure_failure' and "repair_run"."failure_code" is not null) or ("repair_run"."state" = 'cancelled' and "repair_run"."completed_at" is not null and "repair_run"."failure_classification" = 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "repair_run_event" (
	"id" text PRIMARY KEY NOT NULL,
	"repair_run_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"baseline_outcome" text,
	"failure_classification" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_run_event_from_state_check" CHECK ("repair_run_event"."from_state" is null or "repair_run_event"."from_state" in ('created','baseline_running','ready_for_investigation','baseline_failed','infrastructure_failed','cancelled')),
	CONSTRAINT "repair_run_event_to_state_check" CHECK ("repair_run_event"."to_state" in ('created','baseline_running','ready_for_investigation','baseline_failed','infrastructure_failed','cancelled')),
	CONSTRAINT "repair_run_event_transition_check" CHECK (("repair_run_event"."from_state" is null and "repair_run_event"."to_state" = 'created') or ("repair_run_event"."from_state" = 'created' and "repair_run_event"."to_state" in ('baseline_running','cancelled')) or ("repair_run_event"."from_state" = 'baseline_running' and "repair_run_event"."to_state" in ('ready_for_investigation','baseline_failed','infrastructure_failed','cancelled'))),
	CONSTRAINT "repair_run_event_outcome_check" CHECK ("repair_run_event"."baseline_outcome" is null or "repair_run_event"."baseline_outcome" in ('baseline_passed','baseline_failed','installation_failed','typecheck_failed','build_failed','test_failed','timed_out','cancelled','infrastructure_failed','cleanup_failed')),
	CONSTRAINT "repair_run_event_failure_facts_check" CHECK (("repair_run_event"."failure_classification" is null or "repair_run_event"."failure_classification" in ('customer_baseline_failure','infrastructure_failure','cancelled')) and ("repair_run_event"."failure_code" is null or "repair_run_event"."failure_code" ~ '^[a-z_]{1,64}$'))
);
--> statement-breakpoint
ALTER TABLE "repair_run" ADD CONSTRAINT "repair_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repair_run" ADD CONSTRAINT "repair_run_baseline_id_repository_baseline_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."repository_baseline"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repair_run_event" ADD CONSTRAINT "repair_run_event_repair_run_id_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "public"."repair_run"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "repair_run_workspace_idempotency_unique" ON "repair_run" USING btree ("workspace_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "repair_run_active_identity_unique" ON "repair_run" USING btree ("workspace_id","github_repository_id","installation_id","profile_identity","base_commit_sha") WHERE "state" in ('created','baseline_running');
--> statement-breakpoint
CREATE INDEX "repair_run_workspace_created_idx" ON "repair_run" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "repair_run_repository_idx" ON "repair_run" USING btree ("github_repository_id");
--> statement-breakpoint
CREATE INDEX "repair_run_event_run_created_idx" ON "repair_run_event" USING btree ("repair_run_id","created_at");
