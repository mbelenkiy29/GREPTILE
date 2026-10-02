DROP INDEX "mention_replies_source_uq";--> statement-breakpoint
ALTER TABLE "mention_replies" ADD COLUMN "source_kind" text DEFAULT 'issue_comment' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mention_replies_source_uq" ON "mention_replies" USING btree ("repo_id","source_kind","source_comment_id");