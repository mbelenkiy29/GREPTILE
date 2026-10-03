CREATE TYPE "public"."model_call_status" AS ENUM('ok', 'error', 'refused', 'cache_hit');--> statement-breakpoint
CREATE TABLE "embedding_cache" (
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"dims" integer NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_cache_model_content_hash_pk" PRIMARY KEY("model","content_hash")
);
--> statement-breakpoint
CREATE TABLE "llm_response_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"kind" text NOT NULL,
	"response" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" text,
	"repo_id" integer,
	"review_run_id" integer,
	"agent_run_id" integer,
	"task" text NOT NULL,
	"mode" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"status" "model_call_status" NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "llm_response_cache_expires_at_index" ON "llm_response_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "llm_response_cache_org_id_index" ON "llm_response_cache" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "model_calls_org_id_created_at_index" ON "model_calls" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "model_calls_review_run_id_index" ON "model_calls" USING btree ("review_run_id");