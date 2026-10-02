ALTER TABLE "llm_response_cache" ADD COLUMN "org_id" text;--> statement-breakpoint
CREATE INDEX "llm_response_cache_org_id_index" ON "llm_response_cache" USING btree ("org_id");