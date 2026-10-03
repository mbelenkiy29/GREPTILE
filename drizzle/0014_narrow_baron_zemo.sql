CREATE TYPE "public"."finding_resolution" AS ENUM('fixed', 'user', 'outdated');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('open', 'resolved', 'dismissed', 'wont_fix', 'false_positive');--> statement-breakpoint
CREATE TYPE "public"."finding_visibility" AS ENUM('published', 'suppressed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."pull_request_state" AS ENUM('open', 'closed', 'merged');--> statement-breakpoint
CREATE TYPE "public"."review_run_status" AS ENUM('queued', 'ingesting', 'retrieving_context', 'reviewing', 'verifying', 'summarizing', 'publishing', 'completed', 'failed', 'cancelled', 'superseded', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."review_run_trigger" AS ENUM('opened', 'synchronize', 'reopened', 'ready_for_review', 'manual', 'mention', 'api', 'cli', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."usage_kind" AS ENUM('review', 'index', 'chat', 'knowledge', 'embedding', 'eval');--> statement-breakpoint
ALTER TYPE "public"."review_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"review_run_id" integer NOT NULL,
	"agent" text NOT NULL,
	"status" text NOT NULL,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"candidates" integer DEFAULT 0 NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"review_id" integer NOT NULL,
	"pr_number" integer NOT NULL,
	"first_run_id" integer,
	"last_run_id" integer,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"impact" text DEFAULT '' NOT NULL,
	"severity" text NOT NULL,
	"confidence" real NOT NULL,
	"category" text NOT NULL,
	"agent" text NOT NULL,
	"agents" text[] DEFAULT '{}' NOT NULL,
	"path" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"symbol" text,
	"anchor_code" text DEFAULT '' NOT NULL,
	"commit_sha" text NOT NULL,
	"first_seen_sha" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_fix" text DEFAULT '' NOT NULL,
	"suggestion" text,
	"rule_id" text,
	"rule_text" text,
	"verification" jsonb,
	"visibility" "finding_visibility" NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_sha" text,
	"resolution" "finding_resolution",
	"fingerprint" text NOT NULL,
	"external_comment_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_request_commits" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pull_request_id" integer NOT NULL,
	"sha" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"number" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"state" "pull_request_state" DEFAULT 'open' NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"base_ref" text NOT NULL,
	"head_ref" text NOT NULL,
	"base_sha" text NOT NULL,
	"head_sha" text NOT NULL,
	"url" text,
	"last_reviewed_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"merged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"review_id" integer NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text,
	"base_sha" text,
	"since_sha" text,
	"trigger" "review_run_trigger" NOT NULL,
	"mode" text,
	"focus" text,
	"full" boolean DEFAULT false NOT NULL,
	"requested_by" text,
	"status" "review_run_status" DEFAULT 'queued' NOT NULL,
	"status_reason" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"job_id" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stage_timings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"classification" jsonb,
	"context_stats" jsonb,
	"summary" jsonb,
	"models" jsonb,
	"files_reviewed" integer DEFAULT 0 NOT NULL,
	"findings_published" integer DEFAULT 0 NOT NULL,
	"findings_rejected" integer DEFAULT 0 NOT NULL,
	"findings_resolved" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"credits" integer DEFAULT 0 NOT NULL,
	"error" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer,
	"review_run_id" integer,
	"pr_number" integer,
	"author" text,
	"kind" "usage_kind" NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "finding_id" integer;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "pull_request_id" integer;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "last_run_id" integer;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "mode" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "open_findings" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "resolved_findings" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_review_run_id_review_runs_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_first_run_id_review_runs_id_fk" FOREIGN KEY ("first_run_id") REFERENCES "public"."review_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_last_run_id_review_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."review_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_commits" ADD CONSTRAINT "pull_request_commits_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_review_run_id_index" ON "agent_runs" USING btree ("review_run_id");--> statement-breakpoint
CREATE INDEX "agent_runs_org_id_index" ON "agent_runs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_review_fp_uq" ON "findings" USING btree ("review_id","fingerprint");--> statement-breakpoint
CREATE INDEX "findings_org_id_status_severity_index" ON "findings" USING btree ("org_id","status","severity");--> statement-breakpoint
CREATE INDEX "findings_repo_id_created_at_index" ON "findings" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_commits_pr_sha_uq" ON "pull_request_commits" USING btree ("pull_request_id","sha");--> statement-breakpoint
CREATE INDEX "pull_request_commits_org_id_index" ON "pull_request_commits" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_repo_number_uq" ON "pull_requests" USING btree ("repo_id","number");--> statement-breakpoint
CREATE INDEX "pull_requests_org_id_index" ON "pull_requests" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "review_runs_org_id_queued_at_index" ON "review_runs" USING btree ("org_id","queued_at");--> statement-breakpoint
CREATE INDEX "review_runs_review_id_index" ON "review_runs" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "review_runs_status_index" ON "review_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "usage_events_org_id_created_at_index" ON "usage_events" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_last_run_id_review_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."review_runs"("id") ON DELETE set null ON UPDATE no action;