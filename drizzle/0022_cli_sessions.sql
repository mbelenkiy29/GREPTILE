CREATE TYPE "public"."cli_session_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TABLE "cli_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"org_id" text,
	"user_id" text,
	"status" "cli_session_status" DEFAULT 'pending' NOT NULL,
	"api_key_id" integer,
	"client_host" text NOT NULL,
	"client_ip" text,
	"last_polled_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "trigger" text;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cli_sessions_device_code_hash_uq" ON "cli_sessions" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_sessions_user_code_uq" ON "cli_sessions" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "cli_sessions_expires_at_index" ON "cli_sessions" USING btree ("expires_at");