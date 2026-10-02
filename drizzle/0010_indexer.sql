CREATE TYPE "public"."chunk_kind" AS ENUM('code', 'doc', 'config');--> statement-breakpoint
CREATE TYPE "public"."dependency_ecosystem" AS ENUM('npm', 'pypi', 'go', 'cargo', 'maven', 'nuget', 'rubygems');--> statement-breakpoint
CREATE TYPE "public"."dependency_kind" AS ENUM('prod', 'dev', 'peer', 'build', 'optional');--> statement-breakpoint
CREATE TYPE "public"."index_job_kind" AS ENUM('full', 'incremental');--> statement-breakpoint
CREATE TYPE "public"."index_job_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."index_job_trigger" AS ENUM('install', 'push', 'manual', 'schedule', 'api');--> statement-breakpoint
ALTER TYPE "public"."edge_kind" ADD VALUE 'export';--> statement-breakpoint
ALTER TYPE "public"."edge_kind" ADD VALUE 'reference';--> statement-breakpoint
ALTER TYPE "public"."edge_kind" ADD VALUE 'extends';--> statement-breakpoint
ALTER TYPE "public"."edge_kind" ADD VALUE 'implements';--> statement-breakpoint
ALTER TYPE "public"."edge_kind" ADD VALUE 'depends_on';--> statement-breakpoint
ALTER TYPE "public"."edge_kind" ADD VALUE 'tested_by';--> statement-breakpoint
ALTER TYPE "public"."edge_kind" ADD VALUE 'route_handler';--> statement-breakpoint
ALTER TYPE "public"."edge_kind" ADD VALUE 'schema_consumer';--> statement-breakpoint
CREATE TABLE "file_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"path" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"kind" "chunk_kind" NOT NULL,
	"content" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED,
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "index_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"kind" "index_job_kind" NOT NULL,
	"trigger" "index_job_trigger" NOT NULL,
	"status" "index_job_status" DEFAULT 'queued' NOT NULL,
	"from_sha" text,
	"to_sha" text,
	"queue_job_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"progress" jsonb DEFAULT '{"phase":"queued","filesTotal":0,"filesDone":0,"filesChanged":0,"filesRemoved":0,"filesSkipped":{},"symbols":0,"edges":0,"secretLinesRedacted":0}'::jsonb NOT NULL,
	"changed_files" text[] DEFAULT '{}' NOT NULL,
	"error" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repo_commits" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"sha" text NOT NULL,
	"parent_sha" text,
	"message" text NOT NULL,
	"author" text NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"changed_paths" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_dependencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"manifest_path" text NOT NULL,
	"ecosystem" "dependency_ecosystem" NOT NULL,
	"name" text NOT NULL,
	"version_spec" text,
	"kind" "dependency_kind" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "size_bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "line_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "languages" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "last_index_job_id" integer;--> statement-breakpoint
ALTER TABLE "symbols" ADD COLUMN "parent_id" integer;--> statement-breakpoint
ALTER TABLE "symbols" ADD COLUMN "exported" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "symbols" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "symbols" ADD COLUMN "qualified_name" text;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "index_jobs" ADD CONSTRAINT "index_jobs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_commits" ADD CONSTRAINT "repo_commits_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_dependencies" ADD CONSTRAINT "repo_dependencies_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_dependencies" ADD CONSTRAINT "repo_dependencies_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_chunks_tsv_gin" ON "file_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "file_chunks_repo_id_path_index" ON "file_chunks" USING btree ("repo_id","path");--> statement-breakpoint
CREATE INDEX "file_chunks_file_id_index" ON "file_chunks" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "file_chunks_org_id_index" ON "file_chunks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "index_jobs_org_id_repo_id_id_index" ON "index_jobs" USING btree ("org_id","repo_id","id");--> statement-breakpoint
CREATE INDEX "index_jobs_repo_id_queue_job_id_index" ON "index_jobs" USING btree ("repo_id","queue_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_commits_repo_sha_uq" ON "repo_commits" USING btree ("repo_id","sha");--> statement-breakpoint
CREATE INDEX "repo_commits_repo_id_committed_at_index" ON "repo_commits" USING btree ("repo_id","committed_at");--> statement-breakpoint
CREATE INDEX "repo_commits_paths_gin" ON "repo_commits" USING gin ("changed_paths");--> statement-breakpoint
CREATE INDEX "repo_commits_org_id_index" ON "repo_commits" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_dependencies_uq" ON "repo_dependencies" USING btree ("repo_id","manifest_path","ecosystem","name","kind");--> statement-breakpoint
CREATE INDEX "repo_dependencies_repo_id_name_index" ON "repo_dependencies" USING btree ("repo_id","name");--> statement-breakpoint
CREATE INDEX "repo_dependencies_org_id_index" ON "repo_dependencies" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_last_index_job_id_index_jobs_id_fk" FOREIGN KEY ("last_index_job_id") REFERENCES "public"."index_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbols" ADD CONSTRAINT "symbols_parent_id_symbols_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."symbols"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edges_repo_id_kind_from_file_id_index" ON "edges" USING btree ("repo_id","kind","from_file_id");--> statement-breakpoint
CREATE INDEX "edges_repo_id_target_name_index" ON "edges" USING btree ("repo_id","target_name");--> statement-breakpoint
CREATE INDEX "files_tags_gin" ON "files" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "symbols_repo_id_kind_index" ON "symbols" USING btree ("repo_id","kind");--> statement-breakpoint
CREATE INDEX "symbols_repo_id_qualified_name_index" ON "symbols" USING btree ("repo_id","qualified_name");