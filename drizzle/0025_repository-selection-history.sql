ALTER TABLE "repository" ADD COLUMN "is_selected" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "repository" DROP CONSTRAINT "repository_workspace_id_unique";
--> statement-breakpoint
CREATE INDEX "repository_workspace_id_idx" ON "repository" USING btree ("workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "repository_one_selected_per_workspace_unique" ON "repository" USING btree ("workspace_id") WHERE "is_selected" = true;
