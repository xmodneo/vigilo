CREATE TABLE "github_installation" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"github_account_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installation_workspace_id_unique" UNIQUE("workspace_id"),
	CONSTRAINT "github_installation_account_type_check" CHECK ("github_installation"."account_type" in ('User', 'Organization')),
	CONSTRAINT "github_installation_status_check" CHECK ("github_installation"."status" = 'active')
);
--> statement-breakpoint
CREATE TABLE "github_installation_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"phase" text NOT NULL,
	"installation_id" bigint,
	"code_verifier" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installation_attempt_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "github_installation_attempt_phase_check" CHECK ("github_installation_attempt"."phase" in ('installation', 'authorization'))
);
--> statement-breakpoint
ALTER TABLE "github_installation" ADD CONSTRAINT "github_installation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation_attempt" ADD CONSTRAINT "github_installation_attempt_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation_attempt" ADD CONSTRAINT "github_installation_attempt_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_installation_attempt_workspace_id_idx" ON "github_installation_attempt" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "github_installation_attempt_session_id_idx" ON "github_installation_attempt" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "github_installation_attempt_expires_at_idx" ON "github_installation_attempt" USING btree ("expires_at");
