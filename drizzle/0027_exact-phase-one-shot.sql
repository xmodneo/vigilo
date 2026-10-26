ALTER TABLE "operational_worker_heartbeat" ADD COLUMN "target_queue_name" text;--> statement-breakpoint
ALTER TABLE "operational_worker_heartbeat" DROP CONSTRAINT "operational_worker_heartbeat_service_check";--> statement-breakpoint
ALTER TABLE "operational_worker_heartbeat" ADD CONSTRAINT "operational_worker_heartbeat_service_check" CHECK ("service" IN ('vigilo-worker','vigilo-baseline-one-shot','vigilo-exact-one-shot'));--> statement-breakpoint
ALTER TABLE "operational_worker_heartbeat" DROP CONSTRAINT "operational_worker_heartbeat_release_check";--> statement-breakpoint
ALTER TABLE "operational_worker_heartbeat" ADD CONSTRAINT "operational_worker_heartbeat_release_check" CHECK (
  "release_sha" ~ '^[0-9a-f]{40}$' AND "expected_schema_version" IN ('0023','0024','0025','0026','0027')
  AND ("service" <> 'vigilo-baseline-one-shot' OR "expected_schema_version" IN ('0026','0027'))
  AND ("service" <> 'vigilo-exact-one-shot' OR "expected_schema_version" = '0027')
);--> statement-breakpoint
ALTER TABLE "operational_worker_heartbeat" DROP CONSTRAINT "operational_worker_heartbeat_queues_check";--> statement-breakpoint
ALTER TABLE "operational_worker_heartbeat" ADD CONSTRAINT "operational_worker_heartbeat_queues_check" CHECK (
  ("service" = 'vigilo-worker' AND "target_repair_run_id" IS NULL AND "target_job_id" IS NULL AND "target_queue_name" IS NULL
    AND "registered_queues" = '["ai-candidate-generation-v1","ai-investigation-v1","candidate-verification-v1","investigation-context-v1","repair-baseline-v1","repair-loop-v1","repair-publication-v1"]'::jsonb)
  OR ("service" = 'vigilo-baseline-one-shot' AND "target_repair_run_id" IS NOT NULL
    AND "target_repair_run_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "target_job_id" IS NOT NULL AND "target_job_id" = "target_repair_run_id" AND "target_queue_name" IS NULL
    AND "registered_queues" = '["repair-baseline-reviewed-v1"]'::jsonb)
  OR ("service" = 'vigilo-exact-one-shot' AND "target_repair_run_id" IS NOT NULL AND "target_job_id" IS NOT NULL
    AND "target_repair_run_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "target_job_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "target_queue_name" IS NOT NULL
    AND "target_queue_name" IN ('investigation-context-v1','ai-investigation-v1','repair-loop-v1','ai-candidate-generation-v1','candidate-verification-v1')
    AND "registered_queues" = jsonb_build_array("target_queue_name"))
);--> statement-breakpoint
CREATE UNIQUE INDEX "operational_exact_one_shot_live_job_unique" ON "operational_worker_heartbeat" ("target_job_id")
  WHERE "service" = 'vigilo-exact-one-shot' AND "state" <> 'stopped';--> statement-breakpoint
CREATE UNIQUE INDEX "operational_exact_one_shot_live_run_unique" ON "operational_worker_heartbeat" ("target_repair_run_id")
  WHERE "service" = 'vigilo-exact-one-shot' AND "state" <> 'stopped';--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_operational_worker_heartbeat"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."started_at" := statement_timestamp();
    NEW."last_heartbeat_at" := NEW."started_at";
    NEW."state" := 'starting';
    NEW."stopped_at" := NULL;
    RETURN NEW;
  END IF;
  IF ROW(OLD."id",OLD."service",OLD."release_sha",OLD."expected_schema_version",OLD."registered_queues",OLD."target_repair_run_id",OLD."target_job_id",OLD."target_queue_name",OLD."started_at")
     IS DISTINCT FROM ROW(NEW."id",NEW."service",NEW."release_sha",NEW."expected_schema_version",NEW."registered_queues",NEW."target_repair_run_id",NEW."target_job_id",NEW."target_queue_name",NEW."started_at") THEN
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
$$ LANGUAGE plpgsql;
