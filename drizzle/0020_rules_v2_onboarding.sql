CREATE TYPE "public"."rule_category" AS ENUM('correctness', 'security', 'data', 'api_compat', 'testing', 'performance', 'rules', 'style');--> statement-breakpoint
CREATE TYPE "public"."rule_severity" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "category" "rule_category" DEFAULT 'rules' NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "severity" "rule_severity" DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "instructions" text DEFAULT '' NOT NULL;