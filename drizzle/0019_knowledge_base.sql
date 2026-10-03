CREATE TYPE "public"."knowledge_kind" AS ENUM('architecture', 'authentication', 'authorization', 'database', 'api', 'background_jobs', 'billing', 'integrations', 'testing', 'deployment', 'security', 'frontend', 'other');--> statement-breakpoint
CREATE TYPE "public"."knowledge_run_status" AS ENUM('queued', 'running', 'completed', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source" AS ENUM('generated', 'edited');--> statement-breakpoint
CREATE TABLE "knowledge_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"kind" "knowledge_kind" NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"related_files" text[] DEFAULT '{}' NOT NULL,
	"key_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dependencies" jsonb DEFAULT '{"internal":[],"external":[]}'::jsonb NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conventions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"past_findings" jsonb DEFAULT '{"total":0,"counts":{"critical":0,"high":0,"medium":0,"low":0},"recent":[]}'::jsonb NOT NULL,
	"facts" jsonb DEFAULT '{"routes":[],"tables":[],"tests":[],"ciJobs":[],"fileCount":0}'::jsonb NOT NULL,
	"source_fingerprint" text,
	"last_commit_sha" text,
	"last_updated_at" timestamp with time zone,
	"stale" boolean DEFAULT true NOT NULL,
	"source" "knowledge_source" DEFAULT 'generated' NOT NULL,
	"proposed_description" text,
	"proposed_at" timestamp with time zone,
	"edited_by" text,
	"edited_at" timestamp with time zone,
	"rank" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"trigger" text NOT NULL,
	"mode" text DEFAULT 'auto' NOT NULL,
	"slug" text,
	"index_job_id" integer,
	"status" "knowledge_run_status" DEFAULT 'queued' NOT NULL,
	"reason" text,
	"sha" text,
	"discovered" integer DEFAULT 0 NOT NULL,
	"marked_stale" integer DEFAULT 0 NOT NULL,
	"generated" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"remaining" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_runs" ADD CONSTRAINT "knowledge_runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_entries_repo_slug_uq" ON "knowledge_entries" USING btree ("repo_id","slug");--> statement-breakpoint
CREATE INDEX "knowledge_entries_org_id_repo_id_index" ON "knowledge_entries" USING btree ("org_id","repo_id");--> statement-breakpoint
CREATE INDEX "knowledge_runs_org_id_repo_id_id_index" ON "knowledge_runs" USING btree ("org_id","repo_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_runs_one_running_uq" ON "knowledge_runs" USING btree ("repo_id") WHERE "knowledge_runs"."status" = 'running';