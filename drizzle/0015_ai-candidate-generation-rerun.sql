ALTER TABLE "ai_candidate_generation" ADD COLUMN "execution_ordinal" integer;--> statement-breakpoint
ALTER TABLE "ai_candidate_generation" DISABLE TRIGGER "ai_candidate_generation_update_guard";--> statement-breakpoint
WITH ranked AS (
	SELECT "id", row_number() OVER (PARTITION BY "ai_investigation_id" ORDER BY "created_at", "id")::integer AS ordinal
	FROM "ai_candidate_generation"
)
UPDATE "ai_candidate_generation" AS generation SET "execution_ordinal" = ranked.ordinal FROM ranked WHERE generation."id" = ranked."id";--> statement-breakpoint
ALTER TABLE "ai_candidate_generation" ENABLE TRIGGER "ai_candidate_generation_update_guard";--> statement-breakpoint
ALTER TABLE "ai_candidate_generation" ALTER COLUMN "execution_ordinal" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_candidate_generation" DROP CONSTRAINT "ai_candidate_generation_ai_investigation_id_key";--> statement-breakpoint
ALTER TABLE "ai_candidate_generation" ADD CONSTRAINT "ai_candidate_generation_execution_ordinal_check" CHECK ("execution_ordinal" >= 1);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_candidate_generation_execution_ordinal_unique" ON "ai_candidate_generation" USING btree ("ai_investigation_id", "execution_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_candidate_generation_active_unique" ON "ai_candidate_generation" USING btree ("ai_investigation_id") WHERE "state" in ('created','queued','generating');
