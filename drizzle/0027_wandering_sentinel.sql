CREATE TABLE "local_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pull_request_id" integer NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"author" text NOT NULL,
	"path" text,
	"line" integer,
	"start_line" integer,
	"in_reply_to" integer,
	"review_id" integer,
	"commit_sha" text,
	"state" text,
	"reactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_pull_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"author" text NOT NULL,
	"base_ref" text NOT NULL,
	"head_ref" text NOT NULL,
	"base_sha" text NOT NULL,
	"head_sha" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "local_comments" ADD CONSTRAINT "local_comments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_comments" ADD CONSTRAINT "local_comments_pull_request_id_local_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."local_pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_pull_requests" ADD CONSTRAINT "local_pull_requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_pull_requests" ADD CONSTRAINT "local_pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_comments_pull_request_id_kind_index" ON "local_comments" USING btree ("pull_request_id","kind");--> statement-breakpoint
CREATE INDEX "local_comments_org_id_index" ON "local_comments" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_pull_requests_repo_number_uq" ON "local_pull_requests" USING btree ("repo_id","number");--> statement-breakpoint
CREATE INDEX "local_pull_requests_org_id_index" ON "local_pull_requests" USING btree ("org_id");