CREATE TYPE "public"."conversation_kind" AS ENUM('issue_comment', 'review_comment', 'review');--> statement-breakpoint
CREATE TYPE "public"."conversation_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."finding_feedback_kind" AS ENUM('useful', 'not_useful', 'resolved', 'wont_fix', 'false_positive');--> statement-breakpoint
CREATE TYPE "public"."finding_feedback_source" AS ENUM('dashboard', 'api', 'mcp', 'cli', 'github_reaction', 'github_reply', 'github_command');--> statement-breakpoint
CREATE TYPE "public"."preference_kind" AS ENUM('pattern', 'category');--> statement-breakpoint
CREATE TYPE "public"."preference_scope" AS ENUM('org', 'repo');--> statement-breakpoint
CREATE TYPE "public"."preference_source" AS ENUM('feedback', 'reply', 'command', 'human_rule');--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" "conversation_role" NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"external_comment_id" bigint,
	"intent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"pr_number" integer NOT NULL,
	"finding_id" integer,
	"kind" "conversation_kind" NOT NULL,
	"external_thread_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"finding_id" integer NOT NULL,
	"user_id" text,
	"external_author" text,
	"source" "finding_feedback_source" NOT NULL,
	"kind" "finding_feedback_kind" NOT NULL,
	"note" text,
	"external_id" bigint,
	"pattern_id" integer,
	"counts_for_learning" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learned_patterns" ADD COLUMN "kind" "preference_kind" DEFAULT 'pattern' NOT NULL;--> statement-breakpoint
ALTER TABLE "learned_patterns" ADD COLUMN "scope" "preference_scope" DEFAULT 'repo' NOT NULL;--> statement-breakpoint
ALTER TABLE "learned_patterns" ADD COLUMN "source" "preference_source" DEFAULT 'feedback' NOT NULL;--> statement-breakpoint
ALTER TABLE "learned_patterns" ADD COLUMN "confidence_delta" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learned_patterns" ADD COLUMN "evidence_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learned_patterns" ADD COLUMN "last_signal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_feedback" ADD CONSTRAINT "finding_feedback_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_feedback" ADD CONSTRAINT "finding_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_feedback" ADD CONSTRAINT "finding_feedback_pattern_id_learned_patterns_id_fk" FOREIGN KEY ("pattern_id") REFERENCES "public"."learned_patterns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_external_uq" ON "conversation_messages" USING btree ("conversation_id","role","external_comment_id") WHERE "conversation_messages"."external_comment_id" is not null;--> statement-breakpoint
CREATE INDEX "conversation_messages_conversation_id_created_at_index" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_messages_org_id_index" ON "conversation_messages" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_thread_uq" ON "conversations" USING btree ("repo_id","kind","external_thread_id");--> statement-breakpoint
CREATE INDEX "conversations_org_id_repo_id_pr_number_index" ON "conversations" USING btree ("org_id","repo_id","pr_number");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_feedback_external_uq" ON "finding_feedback" USING btree ("finding_id","source","external_id") WHERE "finding_feedback"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "finding_feedback_user_uq" ON "finding_feedback" USING btree ("finding_id","user_id","kind") WHERE "finding_feedback"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "finding_feedback_org_id_created_at_index" ON "finding_feedback" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "finding_feedback_finding_id_index" ON "finding_feedback" USING btree ("finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "learned_patterns_category_uq" ON "learned_patterns" USING btree ("repo_id","category") WHERE "learned_patterns"."kind" = 'category';