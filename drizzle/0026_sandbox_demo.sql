CREATE TYPE "public"."demo_review_status" AS ENUM('queued', 'running', 'completed', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."runtime_validation_status" AS ENUM('queued', 'running', 'passed', 'failed', 'timeout', 'error', 'skipped');--> statement-breakpoint
CREATE TABLE "demo_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"status" "demo_review_status" DEFAULT 'queued' NOT NULL,
	"client_key" text NOT NULL,
	"pow_nonce" text NOT NULL,
	"pr_title" text,
	"pr_author" text,
	"base_sha" text,
	"head_sha" text,
	"result" jsonb,
	"reason" text,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runtime_validations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"review_run_id" integer NOT NULL,
	"status" "runtime_validation_status" DEFAULT 'queued' NOT NULL,
	"image" text NOT NULL,
	"network" text DEFAULT 'none' NOT NULL,
	"commands" jsonb NOT NULL,
	"failed_step" text,
	"exit_code" integer,
	"duration_ms" integer,
	"output_excerpt" text,
	"output_truncated" boolean DEFAULT false NOT NULL,
	"failing_tests" text[] DEFAULT '{}' NOT NULL,
	"reason" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demo_reviews" ADD CONSTRAINT "demo_reviews_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_reviews" ADD CONSTRAINT "demo_reviews_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_validations" ADD CONSTRAINT "runtime_validations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_validations" ADD CONSTRAINT "runtime_validations_review_run_id_review_runs_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_reviews_pow_nonce_uq" ON "demo_reviews" USING btree ("pow_nonce");--> statement-breakpoint
CREATE INDEX "demo_reviews_client_key_created_at_index" ON "demo_reviews" USING btree ("client_key","created_at");--> statement-breakpoint
CREATE INDEX "demo_reviews_created_at_index" ON "demo_reviews" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "demo_reviews_org_id_index" ON "demo_reviews" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_validations_run_uq" ON "runtime_validations" USING btree ("review_run_id");--> statement-breakpoint
CREATE INDEX "runtime_validations_org_id_index" ON "runtime_validations" USING btree ("org_id");