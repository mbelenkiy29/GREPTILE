CREATE TYPE "public"."feedback_kind" AS ENUM('thumbs_up', 'thumbs_down', 'reply');--> statement-breakpoint
CREATE TYPE "public"."pattern_signal" AS ENUM('suppress', 'boost', 'neutral');--> statement-breakpoint
CREATE TABLE "comment_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"review_comment_id" integer NOT NULL,
	"kind" "feedback_kind" NOT NULL,
	"external_id" bigint NOT NULL,
	"author" text NOT NULL,
	"body" text,
	"sentiment" integer NOT NULL,
	"pattern_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learned_patterns" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"signal" "pattern_signal" DEFAULT 'neutral' NOT NULL,
	"positive" integer DEFAULT 0 NOT NULL,
	"negative" integer DEFAULT 0 NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"user_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comment_feedback" ADD CONSTRAINT "comment_feedback_review_comment_id_review_comments_id_fk" FOREIGN KEY ("review_comment_id") REFERENCES "public"."review_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_feedback" ADD CONSTRAINT "comment_feedback_pattern_id_learned_patterns_id_fk" FOREIGN KEY ("pattern_id") REFERENCES "public"."learned_patterns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_patterns" ADD CONSTRAINT "learned_patterns_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_patterns" ADD CONSTRAINT "learned_patterns_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_feedback_uq" ON "comment_feedback" USING btree ("review_comment_id","kind","external_id");--> statement-breakpoint
CREATE INDEX "comment_feedback_org_id_index" ON "comment_feedback" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "learned_patterns_org_id_repo_id_index" ON "learned_patterns" USING btree ("org_id","repo_id");