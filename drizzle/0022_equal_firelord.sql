CREATE TABLE "billing_accounts" (
	"org_id" text PRIMARY KEY NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_seat_item_id" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"seats" integer DEFAULT 0 NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"payment_failed_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"type" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_usage_reports" (
	"org_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"reported_credits" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_usage_reports_org_id_period_start_pk" PRIMARY KEY("org_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "usage_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"threshold" integer NOT NULL,
	"value" numeric(14, 4) NOT NULL,
	"limit" numeric(14, 4) NOT NULL,
	"delivered_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_limit_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"pr_number" integer NOT NULL,
	"reason" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"comment_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"monthly_credit_cap" integer,
	"monthly_cost_cap_usd" numeric(12, 2),
	"alert_thresholds" integer[] DEFAULT '{50,80,100}' NOT NULL,
	"alert_webhook_url" text,
	"alert_webhook_secret" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_usage_reports" ADD CONSTRAINT "billing_usage_reports_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_alerts" ADD CONSTRAINT "usage_alerts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_limit_notices" ADD CONSTRAINT "usage_limit_notices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_limit_notices" ADD CONSTRAINT "usage_limit_notices_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_settings" ADD CONSTRAINT "usage_settings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_settings" ADD CONSTRAINT "usage_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_customer_uq" ON "billing_accounts" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "billing_events_org_id_created_at_index" ON "billing_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_alerts_once_uq" ON "usage_alerts" USING btree ("org_id","period_start","metric","threshold");--> statement-breakpoint
CREATE INDEX "usage_alerts_org_id_created_at_index" ON "usage_alerts" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_limit_notices_once_uq" ON "usage_limit_notices" USING btree ("org_id","repo_id","pr_number","reason","period_start");