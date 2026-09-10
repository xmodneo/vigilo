CREATE TABLE "repair_candidate" (
	"id" text PRIMARY KEY NOT NULL,
	"investigation_id" text NOT NULL,
	"repair_run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"base_commit_sha" text NOT NULL,
	"profile_identity" text NOT NULL,
	"format_version" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"proposal_key" text NOT NULL,
	"proposal_identity" text NOT NULL,
	"state" text NOT NULL,
	"candidate_identity" text,
	"changed_file_count" integer NOT NULL,
	"total_result_bytes" integer NOT NULL,
	"rejection_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"freezing_started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_candidate_id_check" CHECK ("repair_candidate"."id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_candidate_commit_check" CHECK ("repair_candidate"."base_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "repair_candidate_profile_check" CHECK ("repair_candidate"."profile_identity" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "repair_candidate_proposal_check" CHECK ("repair_candidate"."proposal_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and "repair_candidate"."proposal_identity" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "repair_candidate_version_check" CHECK ("repair_candidate"."format_version" = 1),
	CONSTRAINT "repair_candidate_state_check" CHECK ("repair_candidate"."state" in ('freezing','frozen','rejected')),
	CONSTRAINT "repair_candidate_counts_check" CHECK ("repair_candidate"."ordinal" >= 1 and "repair_candidate"."changed_file_count" between 1 and 16 and "repair_candidate"."total_result_bytes" between 0 and 524288),
	CONSTRAINT "repair_candidate_rejection_check" CHECK ("repair_candidate"."rejection_code" is null or "repair_candidate"."rejection_code" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "repair_candidate_state_facts_check" CHECK (("repair_candidate"."state" = 'freezing' and "repair_candidate"."candidate_identity" is null and "repair_candidate"."rejection_code" is null and "repair_candidate"."completed_at" is null) or ("repair_candidate"."state" = 'frozen' and "repair_candidate"."candidate_identity" ~ '^[0-9a-f]{64}$' and "repair_candidate"."rejection_code" is null and "repair_candidate"."completed_at" is not null) or ("repair_candidate"."state" = 'rejected' and "repair_candidate"."candidate_identity" is null and "repair_candidate"."rejection_code" is not null and "repair_candidate"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "repair_candidate_file" (
	"candidate_id" text NOT NULL,
	"path" text NOT NULL,
	"operation" text NOT NULL,
	"base_blob_sha" text,
	"base_content_sha256" text,
	"result_content_sha256" text,
	"result_byte_length" integer NOT NULL,
	"resulting_content" text,
	CONSTRAINT "repair_candidate_file_candidate_id_path_pk" PRIMARY KEY("candidate_id","path"),
	CONSTRAINT "repair_candidate_file_path_check" CHECK (char_length("repair_candidate_file"."path") between 1 and 240 and position(chr(92) in "repair_candidate_file"."path") = 0 and "repair_candidate_file"."path" !~ '(^/|(^|/)[.][.](/|$)|[[:cntrl:]])'),
	CONSTRAINT "repair_candidate_file_operation_check" CHECK ("repair_candidate_file"."operation" in ('add','modify','delete')),
	CONSTRAINT "repair_candidate_file_facts_check" CHECK (("repair_candidate_file"."operation" = 'add' and "repair_candidate_file"."base_blob_sha" is null and "repair_candidate_file"."base_content_sha256" is null and "repair_candidate_file"."result_content_sha256" ~ '^[0-9a-f]{64}$' and "repair_candidate_file"."result_byte_length" between 1 and 131072 and "repair_candidate_file"."resulting_content" is not null and octet_length("repair_candidate_file"."resulting_content") = "repair_candidate_file"."result_byte_length") or ("repair_candidate_file"."operation" = 'modify' and "repair_candidate_file"."base_blob_sha" ~ '^[0-9a-f]{40}$' and "repair_candidate_file"."base_content_sha256" ~ '^[0-9a-f]{64}$' and "repair_candidate_file"."result_content_sha256" ~ '^[0-9a-f]{64}$' and "repair_candidate_file"."result_byte_length" between 1 and 131072 and "repair_candidate_file"."resulting_content" is not null and octet_length("repair_candidate_file"."resulting_content") = "repair_candidate_file"."result_byte_length") or ("repair_candidate_file"."operation" = 'delete' and "repair_candidate_file"."base_blob_sha" ~ '^[0-9a-f]{40}$' and "repair_candidate_file"."base_content_sha256" ~ '^[0-9a-f]{64}$' and "repair_candidate_file"."result_content_sha256" is null and "repair_candidate_file"."result_byte_length" = 0 and "repair_candidate_file"."resulting_content" is null))
);
--> statement-breakpoint
CREATE TABLE "repair_candidate_event" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"event_type" text NOT NULL,
	"candidate_ordinal" integer NOT NULL,
	"changed_file_count" integer NOT NULL,
	"total_result_bytes" integer NOT NULL,
	"candidate_identity" text,
	"rejection_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_candidate_event_id_check" CHECK ("repair_candidate_event"."id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "repair_candidate_event_type_check" CHECK ("repair_candidate_event"."event_type" in ('created','freeze_started','frozen','rejected')),
	CONSTRAINT "repair_candidate_event_counts_check" CHECK ("repair_candidate_event"."candidate_ordinal" >= 1 and "repair_candidate_event"."changed_file_count" between 1 and 16 and "repair_candidate_event"."total_result_bytes" between 0 and 524288),
	CONSTRAINT "repair_candidate_event_facts_check" CHECK (("repair_candidate_event"."event_type" in ('created','freeze_started') and "repair_candidate_event"."candidate_identity" is null and "repair_candidate_event"."rejection_code" is null) or ("repair_candidate_event"."event_type" = 'frozen' and "repair_candidate_event"."candidate_identity" ~ '^[0-9a-f]{64}$' and "repair_candidate_event"."rejection_code" is null) or ("repair_candidate_event"."event_type" = 'rejected' and "repair_candidate_event"."candidate_identity" is null and "repair_candidate_event"."rejection_code" ~ '^[a-z_]{1,64}$'))
);
--> statement-breakpoint
ALTER TABLE "repair_candidate" ADD CONSTRAINT "repair_candidate_investigation_id_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigation"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repair_candidate" ADD CONSTRAINT "repair_candidate_repair_run_id_repair_run_id_fk" FOREIGN KEY ("repair_run_id") REFERENCES "public"."repair_run"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repair_candidate" ADD CONSTRAINT "repair_candidate_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repair_candidate_file" ADD CONSTRAINT "repair_candidate_file_candidate_id_repair_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."repair_candidate"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repair_candidate_event" ADD CONSTRAINT "repair_candidate_event_candidate_id_repair_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."repair_candidate"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repair_candidate_event" ADD CONSTRAINT "repair_candidate_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "repair_candidate_investigation_ordinal_unique" ON "repair_candidate" USING btree ("investigation_id","ordinal");
--> statement-breakpoint
CREATE UNIQUE INDEX "repair_candidate_investigation_proposal_unique" ON "repair_candidate" USING btree ("investigation_id","proposal_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "repair_candidate_active_unique" ON "repair_candidate" USING btree ("investigation_id") WHERE "repair_candidate"."state" = 'freezing';
--> statement-breakpoint
CREATE INDEX "repair_candidate_workspace_created_idx" ON "repair_candidate" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "repair_candidate_event_candidate_created_idx" ON "repair_candidate_event" USING btree ("candidate_id","created_at");
--> statement-breakpoint
CREATE FUNCTION "guard_repair_candidate_update"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'repair candidates are immutable';
	END IF;
	IF OLD."state" IN ('frozen', 'rejected') THEN
		RAISE EXCEPTION 'completed repair candidates are immutable';
	END IF;
	IF ROW(OLD."investigation_id", OLD."repair_run_id", OLD."workspace_id", OLD."github_repository_id", OLD."installation_id", OLD."base_commit_sha", OLD."profile_identity", OLD."format_version", OLD."ordinal", OLD."proposal_key", OLD."proposal_identity", OLD."changed_file_count", OLD."total_result_bytes", OLD."created_at", OLD."freezing_started_at") IS DISTINCT FROM ROW(NEW."investigation_id", NEW."repair_run_id", NEW."workspace_id", NEW."github_repository_id", NEW."installation_id", NEW."base_commit_sha", NEW."profile_identity", NEW."format_version", NEW."ordinal", NEW."proposal_key", NEW."proposal_identity", NEW."changed_file_count", NEW."total_result_bytes", NEW."created_at", NEW."freezing_started_at") THEN
		RAISE EXCEPTION 'repair candidate authority and proposal facts are immutable';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "repair_candidate_update_guard" BEFORE UPDATE OR DELETE ON "repair_candidate" FOR EACH ROW EXECUTE FUNCTION "guard_repair_candidate_update"();
--> statement-breakpoint
CREATE FUNCTION "guard_repair_candidate_file_mutation"() RETURNS trigger AS $$
DECLARE parent_state text;
BEGIN
	IF TG_OP <> 'INSERT' THEN
		RAISE EXCEPTION 'repair candidate files are immutable';
	END IF;
	SELECT "state" INTO parent_state FROM "repair_candidate" WHERE "id" = NEW."candidate_id";
	IF parent_state IS DISTINCT FROM 'freezing' THEN
		RAISE EXCEPTION 'repair candidate files may only be added while freezing';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "repair_candidate_file_mutation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "repair_candidate_file" FOR EACH ROW EXECUTE FUNCTION "guard_repair_candidate_file_mutation"();
--> statement-breakpoint
CREATE FUNCTION "guard_repair_candidate_event_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'repair candidate events are append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "repair_candidate_event_mutation_guard" BEFORE UPDATE OR DELETE ON "repair_candidate_event" FOR EACH ROW EXECUTE FUNCTION "guard_repair_candidate_event_mutation"();
