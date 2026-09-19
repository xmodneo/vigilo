ALTER TABLE "ai_candidate_generation" DROP CONSTRAINT "ai_candidate_generation_provider_check";--> statement-breakpoint
ALTER TABLE "ai_candidate_generation" ADD CONSTRAINT "ai_candidate_generation_provider_check" CHECK (char_length("provider_id") between 1 and 40 and char_length("model_id") between 1 and 80 and "protocol_version" in (1,2,3));
