CREATE TYPE "public"."rule_status" AS ENUM('active', 'candidate', 'rejected');--> statement-breakpoint
CREATE TABLE "rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer,
	"text" text NOT NULL,
	"paths" text[] DEFAULT '{}' NOT NULL,
	"status" "rule_status" DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'dashboard' NOT NULL,
	"rationale" text,
	"evidence" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "rule_id" text;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rules_org_id_status_index" ON "rules" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "rules_repo_id_index" ON "rules" USING btree ("repo_id");