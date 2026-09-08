CREATE TABLE "github_repository_access_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"state_hash" text NOT NULL,
	"operation" text NOT NULL,
	"repository_id" bigint,
	"code_verifier" text,
	"repositories_json" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_repository_access_attempt_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "github_repository_access_attempt_operation_check" CHECK ("github_repository_access_attempt"."operation" in ('list', 'select')),
	CONSTRAINT "github_repository_access_attempt_repository_check" CHECK (("github_repository_access_attempt"."operation" = 'list' and "github_repository_access_attempt"."repository_id" is null) or ("github_repository_access_attempt"."operation" = 'select' and "github_repository_access_attempt"."repository_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "github_repository_access_attempt" ADD CONSTRAINT "github_repository_access_attempt_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repository_access_attempt" ADD CONSTRAINT "github_repository_access_attempt_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repository_access_attempt" ADD CONSTRAINT "github_repository_access_attempt_installation_id_github_installation_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installation"("installation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_repository_access_attempt_workspace_id_idx" ON "github_repository_access_attempt" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "github_repository_access_attempt_session_id_idx" ON "github_repository_access_attempt" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "github_repository_access_attempt_expires_at_idx" ON "github_repository_access_attempt" USING btree ("expires_at");
