CREATE TABLE "repository" (
	"github_repository_id" bigint PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"owner_id" bigint NOT NULL,
	"owner_login" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text,
	"is_private" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_installation_id_github_installation_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installation"("installation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_installation_id_idx" ON "repository" USING btree ("installation_id");
