-- Learned preferences (R6.10): org-wide patterns (no repo) get scope 'org', and every existing pattern's evidence
-- count starts from the feedback already folded into it.
UPDATE "learned_patterns" SET "scope" = 'org' WHERE "repo_id" IS NULL;--> statement-breakpoint
UPDATE "learned_patterns" SET "evidence_count" = "positive" + "negative", "last_signal_at" = "updated_at" WHERE "positive" + "negative" > 0;
