CREATE TABLE "execution_profile" (
	"github_repository_id" bigint PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"profile_version" integer NOT NULL,
	"profile_identity" text,
	"base_commit_sha" text NOT NULL,
	"runtime_family" text,
	"node_major" integer,
	"package_manager" text,
	"lockfile_type" text,
	"install_operation" text,
	"typecheck_script" text,
	"build_script" text,
	"test_script" text,
	"test_runner" text,
	"package_json_blob_sha" text,
	"package_json_content_sha256" text,
	"package_lock_blob_sha" text,
	"package_lock_content_sha256" text,
	"status" text NOT NULL,
	"unsupported_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_profile_profile_identity_unique" UNIQUE("profile_identity"),
	CONSTRAINT "execution_profile_version_check" CHECK ("execution_profile"."profile_version" = 2),
	CONSTRAINT "execution_profile_commit_sha_check" CHECK ("execution_profile"."base_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "execution_profile_status_check" CHECK ("execution_profile"."status" in ('ready', 'unsupported')),
	CONSTRAINT "execution_profile_ready_fields_check" CHECK ((
		"execution_profile"."status" = 'ready'
		and "execution_profile"."profile_identity" ~ '^[0-9a-f]{64}$'
		and "execution_profile"."runtime_family" = 'node'
		and "execution_profile"."node_major" = 24
		and "execution_profile"."package_manager" = 'npm'
		and "execution_profile"."lockfile_type" = 'package-lock'
		and "execution_profile"."install_operation" = 'ci'
		and ("execution_profile"."typecheck_script" is null or "execution_profile"."typecheck_script" = 'typecheck')
		and ("execution_profile"."build_script" is null or "execution_profile"."build_script" = 'build')
		and "execution_profile"."test_script" = 'test'
		and "execution_profile"."test_runner" in ('node-test', 'vitest', 'jest')
		and "execution_profile"."package_json_blob_sha" ~ '^[0-9a-f]{40}$'
		and "execution_profile"."package_json_content_sha256" ~ '^[0-9a-f]{64}$'
		and "execution_profile"."package_lock_blob_sha" ~ '^[0-9a-f]{40}$'
		and "execution_profile"."package_lock_content_sha256" ~ '^[0-9a-f]{64}$'
		and "execution_profile"."unsupported_reason" is null
	) or (
		"execution_profile"."status" = 'unsupported'
		and "execution_profile"."profile_identity" is null
		and "execution_profile"."runtime_family" is null
		and "execution_profile"."node_major" is null
		and "execution_profile"."package_manager" is null
		and "execution_profile"."lockfile_type" is null
		and "execution_profile"."install_operation" is null
		and "execution_profile"."typecheck_script" is null
		and "execution_profile"."build_script" is null
		and "execution_profile"."test_script" is null
		and "execution_profile"."test_runner" is null
		and "execution_profile"."package_json_blob_sha" is null
		and "execution_profile"."package_json_content_sha256" is null
		and "execution_profile"."package_lock_blob_sha" is null
		and "execution_profile"."package_lock_content_sha256" is null
		and "execution_profile"."unsupported_reason" in (
			'ambiguous_test_runner',
			'conflicting_lockfiles',
			'invalid_package_lock',
			'invalid_script_graph',
			'malformed_package_json',
			'missing_package_json',
			'missing_package_lock',
			'missing_test_script',
			'unsupported_monorepo',
			'unsupported_node_version',
			'unsupported_package_manager',
			'unsupported_test_runner'
		)
	))
);
--> statement-breakpoint
ALTER TABLE "execution_profile" ADD CONSTRAINT "execution_profile_github_repository_id_repository_github_repository_id_fk" FOREIGN KEY ("github_repository_id") REFERENCES "public"."repository"("github_repository_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_profile" ADD CONSTRAINT "execution_profile_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_profile" ADD CONSTRAINT "execution_profile_installation_id_github_installation_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installation"("installation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "execution_profile_workspace_id_idx" ON "execution_profile" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "execution_profile_installation_id_idx" ON "execution_profile" USING btree ("installation_id");
