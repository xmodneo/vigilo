CREATE TABLE "operational_worker_heartbeat" (
  "id" text PRIMARY KEY NOT NULL,
  "service" text NOT NULL,
  "release_sha" text NOT NULL,
  "expected_schema_version" text NOT NULL,
  "registered_queues" jsonb NOT NULL,
  "state" text NOT NULL,
  "failure_code" text,
  "started_at" timestamp with time zone NOT NULL,
  "last_heartbeat_at" timestamp with time zone NOT NULL,
  "stopped_at" timestamp with time zone,
  CONSTRAINT "operational_worker_heartbeat_uuid_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "operational_worker_heartbeat_service_check" CHECK ("service" = 'vigilo-worker'),
  CONSTRAINT "operational_worker_heartbeat_release_check" CHECK ("release_sha" ~ '^[0-9a-f]{40}$' and "expected_schema_version" = '0023'),
  CONSTRAINT "operational_worker_heartbeat_queues_check" CHECK (
    jsonb_typeof("registered_queues") = 'array'
    and jsonb_array_length("registered_queues") = 7
    and "registered_queues" = '["ai-candidate-generation-v1","ai-investigation-v1","candidate-verification-v1","investigation-context-v1","repair-baseline-v1","repair-loop-v1","repair-publication-v1"]'::jsonb
  ),
  CONSTRAINT "operational_worker_heartbeat_state_check" CHECK ("state" in ('starting','ready','draining','stopped')),
  CONSTRAINT "operational_worker_heartbeat_failure_check" CHECK ("failure_code" is null or "failure_code" ~ '^[a-z_]{1,64}$'),
  CONSTRAINT "operational_worker_heartbeat_time_check" CHECK ("last_heartbeat_at" >= "started_at" and (("state" = 'stopped' and "stopped_at" is not null) or ("state" <> 'stopped' and "stopped_at" is null)))
);--> statement-breakpoint
CREATE INDEX "operational_worker_heartbeat_freshness_idx" ON "operational_worker_heartbeat" ("service","state","last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "operational_worker_heartbeat_stopped_idx" ON "operational_worker_heartbeat" ("stopped_at") WHERE "state" = 'stopped';--> statement-breakpoint

CREATE FUNCTION "guard_operational_worker_heartbeat"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."started_at" := statement_timestamp();
    NEW."last_heartbeat_at" := NEW."started_at";
    NEW."state" := 'starting';
    NEW."stopped_at" := NULL;
    RETURN NEW;
  END IF;
  IF ROW(OLD."id",OLD."service",OLD."release_sha",OLD."expected_schema_version",OLD."registered_queues",OLD."started_at")
     IS DISTINCT FROM ROW(NEW."id",NEW."service",NEW."release_sha",NEW."expected_schema_version",NEW."registered_queues",NEW."started_at") THEN
    RAISE EXCEPTION 'worker heartbeat identity is immutable';
  END IF;
  IF OLD."state" = 'stopped' OR
     (OLD."state" = 'starting' AND NEW."state" NOT IN ('starting','ready','draining','stopped')) OR
     (OLD."state" = 'ready' AND NEW."state" NOT IN ('ready','draining','stopped')) OR
     (OLD."state" = 'draining' AND NEW."state" NOT IN ('draining','stopped')) THEN
    RAISE EXCEPTION 'worker heartbeat transition invalid';
  END IF;
  NEW."last_heartbeat_at" := statement_timestamp();
  NEW."stopped_at" := CASE WHEN NEW."state" = 'stopped' THEN statement_timestamp() ELSE NULL END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "operational_worker_heartbeat_guard" BEFORE INSERT OR UPDATE ON "operational_worker_heartbeat" FOR EACH ROW EXECUTE FUNCTION "guard_operational_worker_heartbeat"();--> statement-breakpoint

CREATE TABLE "http_rate_limit_bucket" (
  "action" text NOT NULL,
  "subject_hash" text NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "request_count" integer NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "http_rate_limit_bucket_pk" PRIMARY KEY("action","subject_hash","window_started_at"),
  CONSTRAINT "http_rate_limit_bucket_action_check" CHECK ("action" in ('auth','oauth_callback','repository_connect','repository_select','profile_detect','repair_start','workflow_start','human_review','publication','poll','health','readiness')),
  CONSTRAINT "http_rate_limit_bucket_subject_check" CHECK ("subject_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "http_rate_limit_bucket_count_check" CHECK ("request_count" between 1 and 100000),
  CONSTRAINT "http_rate_limit_bucket_window_check" CHECK ("expires_at" > "window_started_at" and "updated_at" >= "window_started_at")
);--> statement-breakpoint
CREATE INDEX "http_rate_limit_bucket_expiry_idx" ON "http_rate_limit_bucket" ("expires_at");
