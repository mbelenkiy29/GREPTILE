CREATE TYPE "public"."delivery_status" AS ENUM('processing', 'accepted', 'ignored', 'failed');--> statement-breakpoint
CREATE TABLE "pending_installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"external_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"sender_login" text NOT NULL,
	"sender_id" bigint,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"repository_selection" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "account_type" text;--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "repository_selection" text;--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "permissions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "missing_permissions" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "installation_id" bigint;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "repo_id" integer;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "repo_full_name" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "status" "delivery_status" DEFAULT 'processing' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "jobs" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "payload_sha256" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_installations_provider_external_uq" ON "pending_installations" USING btree ("provider","external_id");--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_org_id_received_at_index" ON "webhook_deliveries" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_received_at_index" ON "webhook_deliveries" USING btree ("status","received_at");