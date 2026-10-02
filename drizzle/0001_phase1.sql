CREATE TYPE "public"."edge_kind" AS ENUM('call', 'import');--> statement-breakpoint
CREATE TYPE "public"."index_status" AS ENUM('pending', 'indexing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('queued', 'running', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "edges" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"kind" "edge_kind" NOT NULL,
	"from_file_id" integer NOT NULL,
	"from_symbol_id" integer,
	"target_name" text NOT NULL,
	"to_file_id" integer,
	"to_symbol_id" integer,
	"line" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"path" text NOT NULL,
	"language" text NOT NULL,
	"content_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"external_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mention_replies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"pr_number" integer NOT NULL,
	"source_comment_id" bigint NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"reply_comment_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"installation_id" integer NOT NULL,
	"external_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"private" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"index_status" "index_status" DEFAULT 'pending' NOT NULL,
	"index_error" text,
	"indexed_sha" text,
	"indexed_at" timestamp with time zone,
	"file_count" integer DEFAULT 0 NOT NULL,
	"symbol_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"review_id" integer NOT NULL,
	"path" text NOT NULL,
	"line" integer NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"fingerprint" text NOT NULL,
	"external_id" bigint,
	"head_sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_title" text DEFAULT '' NOT NULL,
	"pr_author" text DEFAULT '' NOT NULL,
	"head_sha" text NOT NULL,
	"status" "review_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"risk_level" text,
	"confidence" integer,
	"summary" text,
	"summary_comment_id" bigint,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "symbols" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_from_file_id_files_id_fk" FOREIGN KEY ("from_file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_from_symbol_id_symbols_id_fk" FOREIGN KEY ("from_symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_to_file_id_files_id_fk" FOREIGN KEY ("to_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_to_symbol_id_symbols_id_fk" FOREIGN KEY ("to_symbol_id") REFERENCES "public"."symbols"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_replies" ADD CONSTRAINT "mention_replies_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbols" ADD CONSTRAINT "symbols_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbols" ADD CONSTRAINT "symbols_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edges_repo_id_kind_to_symbol_id_index" ON "edges" USING btree ("repo_id","kind","to_symbol_id");--> statement-breakpoint
CREATE INDEX "edges_repo_id_kind_to_file_id_index" ON "edges" USING btree ("repo_id","kind","to_file_id");--> statement-breakpoint
CREATE INDEX "edges_from_symbol_id_index" ON "edges" USING btree ("from_symbol_id");--> statement-breakpoint
CREATE INDEX "edges_org_id_index" ON "edges" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "files_repo_path_uq" ON "files" USING btree ("repo_id","path");--> statement-breakpoint
CREATE INDEX "files_org_id_index" ON "files" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installations_provider_external_uq" ON "installations" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "installations_org_id_index" ON "installations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mention_replies_source_uq" ON "mention_replies" USING btree ("repo_id","source_comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_installation_external_uq" ON "repos" USING btree ("installation_id","external_id");--> statement-breakpoint
CREATE INDEX "repos_org_id_index" ON "repos" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_comments_review_fp_uq" ON "review_comments" USING btree ("review_id","fingerprint");--> statement-breakpoint
CREATE INDEX "review_comments_org_id_index" ON "review_comments" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_repo_pr_uq" ON "reviews" USING btree ("repo_id","pr_number");--> statement-breakpoint
CREATE INDEX "reviews_org_id_created_at_index" ON "reviews" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "symbols_repo_id_name_index" ON "symbols" USING btree ("repo_id","name");--> statement-breakpoint
CREATE INDEX "symbols_file_id_index" ON "symbols" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "symbols_org_id_index" ON "symbols" USING btree ("org_id");