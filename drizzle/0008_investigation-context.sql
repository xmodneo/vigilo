ALTER TABLE "repair_run" DROP CONSTRAINT "repair_run_state_facts_check";
--> statement-breakpoint
ALTER TABLE "repair_run" ADD CONSTRAINT "repair_run_state_facts_check" CHECK (
	("repair_run"."state" = 'created' and "repair_run"."baseline_started_at" is null and "repair_run"."completed_at" is null and "repair_run"."baseline_id" is null and "repair_run"."baseline_outcome" is null) or
	("repair_run"."state" = 'baseline_running' and "repair_run"."baseline_started_at" is not null and "repair_run"."completed_at" is null and "repair_run"."baseline_id" is null and "repair_run"."baseline_outcome" is null) or
	("repair_run"."state" = 'ready_for_investigation' and "repair_run"."baseline_started_at" is not null and "repair_run"."completed_at" is not null and "repair_run"."baseline_id" is not null and (("repair_run"."baseline_outcome" = 'baseline_passed' and "repair_run"."failure_classification" is null and "repair_run"."failure_code" is null) or ("repair_run"."baseline_outcome" in ('baseline_failed','typecheck_failed','build_failed','test_failed') and "repair_run"."failure_classification" = 'customer_baseline_failure' and "repair_run"."failure_code" = "repair_run"."baseline_outcome"))) or
	("repair_run"."state" = 'baseline_failed' and "repair_run"."baseline_started_at" is not null and "repair_run"."completed_at" is not null and "repair_run"."baseline_id" is not null and "repair_run"."baseline_outcome" in ('baseline_failed','typecheck_failed','build_failed','test_failed') and "repair_run"."failure_classification" = 'customer_baseline_failure') or
	("repair_run"."state" = 'infrastructure_failed' and "repair_run"."baseline_started_at" is not null and "repair_run"."completed_at" is not null and "repair_run"."failure_classification" = 'infrastructure_failure' and "repair_run"."failure_code" is not null) or
	("repair_run"."state" = 'cancelled' and "repair_run"."completed_at" is not null and "repair_run"."failure_classification" = 'cancelled')
);
--> statement-breakpoint
CREATE TABLE "repair_intent" (
	"id" text PRIMARY KEY NOT NULL,
	"repair_run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"objective" text NOT NULL,
	"objective_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_intent_repair_run_id_unique" UNIQUE("repair_run_id"),
	CONSTRAINT "repair_intent_id_check" CHECK ("repair_intent"."id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_intent_objective_check" CHECK (char_length("repair_intent"."objective") between 1 and 3000 and octet_length("repair_intent"."objective") between 1 and 3072),
	CONSTRAINT "repair_intent_hash_check" CHECK ("repair_intent"."objective_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "investigation" (
	"id" text PRIMARY KEY NOT NULL,
	"repair_run_id" text NOT NULL,
	"repair_intent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"base_commit_sha" text NOT NULL,
	"profile_identity" text NOT NULL,
	"baseline_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text NOT NULL,
	"context_budget_version" integer NOT NULL,
	"max_tree_entries" integer NOT NULL,
	"max_file_bytes" integer NOT NULL,
	"max_cumulative_bytes" integer NOT NULL,
	"max_operations" integer NOT NULL,
	"tree_sha" text,
	"indexed_path_count" integer DEFAULT 0 NOT NULL,
	"excluded_path_count" integer DEFAULT 0 NOT NULL,
	"tree_truncated" boolean DEFAULT false NOT NULL,
	"attempt_number" integer DEFAULT 0 NOT NULL,
	"ownership_token" text,
	"heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"preparation_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investigation_repair_run_id_unique" UNIQUE("repair_run_id"),
	CONSTRAINT "investigation_repair_intent_id_unique" UNIQUE("repair_intent_id"),
	CONSTRAINT "investigation_id_check" CHECK ("investigation"."id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "investigation_commit_check" CHECK ("investigation"."base_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "investigation_profile_check" CHECK ("investigation"."profile_identity" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "investigation_idempotency_check" CHECK ("investigation"."idempotency_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "investigation_state_check" CHECK ("investigation"."state" in ('created','context_preparing','ready','failed','cancelled')),
	CONSTRAINT "investigation_budget_check" CHECK ("investigation"."context_budget_version" = 1 and "investigation"."max_tree_entries" = 2000 and "investigation"."max_file_bytes" = 65536 and "investigation"."max_cumulative_bytes" = 1048576 and "investigation"."max_operations" = 50),
	CONSTRAINT "investigation_counts_check" CHECK ("investigation"."indexed_path_count" between 0 and 2000 and "investigation"."excluded_path_count" >= 0 and "investigation"."attempt_number" between 0 and 3),
	CONSTRAINT "investigation_failure_check" CHECK ("investigation"."failure_code" is null or "investigation"."failure_code" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "investigation_state_facts_check" CHECK (("investigation"."state" = 'created' and "investigation"."attempt_number" between 0 and 2 and "investigation"."ownership_token" is null and "investigation"."heartbeat_at" is null and "investigation"."lease_expires_at" is null and "investigation"."completed_at" is null and "investigation"."tree_sha" is null) or ("investigation"."state" = 'context_preparing' and "investigation"."attempt_number" between 1 and 3 and "investigation"."ownership_token" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "investigation"."heartbeat_at" is not null and "investigation"."lease_expires_at" is not null and "investigation"."preparation_started_at" is not null and "investigation"."completed_at" is null and "investigation"."tree_sha" is null) or ("investigation"."state" = 'ready' and "investigation"."attempt_number" between 1 and 3 and "investigation"."ownership_token" is null and "investigation"."lease_expires_at" is null and "investigation"."completed_at" is not null and "investigation"."tree_sha" ~ '^[0-9a-f]{40}$' and "investigation"."failure_code" is null) or ("investigation"."state" in ('failed','cancelled') and "investigation"."ownership_token" is null and "investigation"."lease_expires_at" is null and "investigation"."completed_at" is not null and "investigation"."failure_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "investigation_context_entry" (
	"investigation_id" text NOT NULL,
	"path" text NOT NULL,
	"depth" integer NOT NULL,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"object_sha" text NOT NULL,
	"size_bytes" integer,
	"readable" boolean NOT NULL,
	CONSTRAINT "investigation_context_entry_investigation_id_path_pk" PRIMARY KEY("investigation_id","path"),
	CONSTRAINT "investigation_context_entry_path_check" CHECK (char_length("investigation_context_entry"."path") between 1 and 240 and "investigation_context_entry"."path" !~ '(^/|(^|/)[.][.](/|$)|[[:cntrl:]])' and "investigation_context_entry"."depth" between 1 and 20),
	CONSTRAINT "investigation_context_entry_kind_check" CHECK ("investigation_context_entry"."kind" in ('blob','tree','symlink','submodule')),
	CONSTRAINT "investigation_context_entry_mode_check" CHECK ("investigation_context_entry"."mode" in ('040000','100644','100755','120000','160000')),
	CONSTRAINT "investigation_context_entry_sha_check" CHECK ("investigation_context_entry"."object_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "investigation_context_entry_size_check" CHECK ("investigation_context_entry"."size_bytes" is null or "investigation_context_entry"."size_bytes" >= 0),
	CONSTRAINT "investigation_context_entry_readable_check" CHECK ("investigation_context_entry"."readable" is false or ("investigation_context_entry"."kind" = 'blob' and "investigation_context_entry"."mode" in ('100644','100755') and "investigation_context_entry"."size_bytes" between 0 and 65536))
);
--> statement-breakpoint
CREATE TABLE "investigation_context_event" (
	"id" text PRIMARY KEY NOT NULL,
	"investigation_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"operation" text NOT NULL,
	"status" text NOT NULL,
	"request_path" text,
	"query_hash" text,
	"query_bytes" integer,
	"result_count" integer DEFAULT 0 NOT NULL,
	"result_bytes" integer DEFAULT 0 NOT NULL,
	"budget_bytes" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"budget_exhausted" boolean DEFAULT false NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "investigation_context_event_id_check" CHECK ("investigation_context_event"."id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "investigation_context_event_operation_check" CHECK ("investigation_context_event"."operation" in ('prepare','list_paths','read_text_file','search_text','read_baseline_summary')),
	CONSTRAINT "investigation_context_event_status_check" CHECK ("investigation_context_event"."status" in ('started','completed','rejected','failed')),
	CONSTRAINT "investigation_context_event_path_check" CHECK ("investigation_context_event"."request_path" is null or (char_length("investigation_context_event"."request_path") between 1 and 240 and "investigation_context_event"."request_path" !~ '(^/|(^|/)[.][.](/|$)|[[:cntrl:]])')),
	CONSTRAINT "investigation_context_event_query_check" CHECK (("investigation_context_event"."query_hash" is null and "investigation_context_event"."query_bytes" is null) or ("investigation_context_event"."query_hash" ~ '^[0-9a-f]{64}$' and "investigation_context_event"."query_bytes" between 1 and 128)),
	CONSTRAINT "investigation_context_event_counts_check" CHECK ("investigation_context_event"."result_count" >= 0 and "investigation_context_event"."result_bytes" >= 0 and "investigation_context_event"."budget_bytes" between 0 and 1048576),
	CONSTRAINT "investigation_context_event_failure_check" CHECK ("investigation_context_event"."failure_code" is null or "investigation_context_event"."failure_code" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "investigation_context_event_state_check" CHECK (("investigation_context_event"."status" = 'started' and "investigation_context_event"."completed_at" is null and "investigation_context_event"."failure_code" is null) or ("investigation_context_event"."status" = 'completed' and "investigation_context_event"."completed_at" is not null and "investigation_context_event"."failure_code" is null) or ("investigation_context_event"."status" in ('rejected','failed') and "investigation_context_event"."completed_at" is not null and "investigation_context_event"."failure_code" is not null))
);
--> statement-breakpoint
ALTER TABLE "repair_intent" ADD CONSTRAINT "repair_intent_repair_run_id_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "public"."repair_run"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repair_intent" ADD CONSTRAINT "repair_intent_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "investigation" ADD CONSTRAINT "investigation_repair_run_id_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "public"."repair_run"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "investigation" ADD CONSTRAINT "investigation_repair_intent_id_repair_intent_id_fk" FOREIGN KEY ("repair_intent_id") REFERENCES "public"."repair_intent"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "investigation" ADD CONSTRAINT "investigation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "investigation" ADD CONSTRAINT "investigation_baseline_id_repository_baseline_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."repository_baseline"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "investigation_context_entry" ADD CONSTRAINT "investigation_context_entry_investigation_id_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigation"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "investigation_context_event" ADD CONSTRAINT "investigation_context_event_investigation_id_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigation"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "investigation_context_event" ADD CONSTRAINT "investigation_context_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "repair_intent_workspace_idx" ON "repair_intent" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_workspace_idempotency_unique" ON "investigation" USING btree ("workspace_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "investigation_workspace_created_idx" ON "investigation" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "investigation_state_lease_idx" ON "investigation" USING btree ("state","lease_expires_at");
--> statement-breakpoint
CREATE INDEX "investigation_context_entry_investigation_idx" ON "investigation_context_entry" USING btree ("investigation_id","path");
--> statement-breakpoint
CREATE INDEX "investigation_context_event_budget_idx" ON "investigation_context_event" USING btree ("investigation_id","created_at");
