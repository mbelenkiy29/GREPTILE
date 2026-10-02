CREATE TABLE "human_review_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"pr_number" integer NOT NULL,
	"external_id" bigint NOT NULL,
	"author" text NOT NULL,
	"path" text NOT NULL,
	"body" text NOT NULL,
	"mined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "human_review_comments" ADD CONSTRAINT "human_review_comments_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "human_review_comments_uq" ON "human_review_comments" USING btree ("repo_id","external_id");--> statement-breakpoint
CREATE INDEX "human_review_comments_org_id_repo_id_mined_at_index" ON "human_review_comments" USING btree ("org_id","repo_id","mined_at");