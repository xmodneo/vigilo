DROP TRIGGER "ai_investigation_update_guard" ON "ai_investigation";--> statement-breakpoint
ALTER TABLE "ai_investigation" DROP CONSTRAINT "ai_investigation_investigation_id_key";--> statement-breakpoint
ALTER TABLE "ai_investigation" ADD COLUMN "execution_ordinal" integer;--> statement-breakpoint
ALTER TABLE "ai_investigation" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
WITH "ranked" AS (
	SELECT "id", row_number() OVER (PARTITION BY "investigation_id" ORDER BY "created_at", "id")::integer AS "ordinal"
	FROM "ai_investigation"
)
UPDATE "ai_investigation"
SET "execution_ordinal" = "ranked"."ordinal", "idempotency_key" = "ai_investigation"."id"
FROM "ranked"
WHERE "ai_investigation"."id" = "ranked"."id";--> statement-breakpoint
ALTER TABLE "ai_investigation" ALTER COLUMN "execution_ordinal" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_investigation" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_investigation" ADD CONSTRAINT "ai_investigation_execution_check" CHECK ("execution_ordinal" >= 1 and "idempotency_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');--> statement-breakpoint
CREATE UNIQUE INDEX "ai_investigation_ordinal_unique" ON "ai_investigation" USING btree ("investigation_id","execution_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_investigation_idempotency_unique" ON "ai_investigation" USING btree ("investigation_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_investigation_active_unique" ON "ai_investigation" USING btree ("investigation_id") WHERE "state" in ('created','queued','investigating');--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_ai_investigation_update"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI investigations are durable'; END IF;
	IF OLD."state" IN ('completed','failed','cancelled') THEN RAISE EXCEPTION 'completed AI investigations are immutable'; END IF;
	IF OLD."state" IS DISTINCT FROM NEW."state" AND NOT ((OLD."state" = 'created' AND NEW."state" IN ('queued','cancelled')) OR (OLD."state" = 'queued' AND NEW."state" IN ('investigating','cancelled')) OR (OLD."state" = 'investigating' AND NEW."state" IN ('completed','failed','cancelled'))) THEN RAISE EXCEPTION 'invalid AI investigation transition'; END IF;
	IF ROW(OLD."investigation_id",OLD."execution_ordinal",OLD."idempotency_key",OLD."repair_run_id",OLD."baseline_id",OLD."workspace_id",OLD."github_repository_id",OLD."installation_id",OLD."base_commit_sha",OLD."profile_identity",OLD."provider_id",OLD."model_id",OLD."protocol_version",OLD."created_at") IS DISTINCT FROM ROW(NEW."investigation_id",NEW."execution_ordinal",NEW."idempotency_key",NEW."repair_run_id",NEW."baseline_id",NEW."workspace_id",NEW."github_repository_id",NEW."installation_id",NEW."base_commit_sha",NEW."profile_identity",NEW."provider_id",NEW."model_id",NEW."protocol_version",NEW."created_at") THEN RAISE EXCEPTION 'AI investigation authority is immutable'; END IF;
	IF OLD."queued_at" IS DISTINCT FROM NEW."queued_at" AND NOT (OLD."state" = 'created' AND NEW."state" = 'queued' AND OLD."queued_at" IS NULL AND NEW."queued_at" IS NOT NULL) THEN RAISE EXCEPTION 'AI investigation queue time is immutable'; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "ai_investigation_update_guard" BEFORE UPDATE OR DELETE ON "ai_investigation" FOR EACH ROW EXECUTE FUNCTION "guard_ai_investigation_update"();
