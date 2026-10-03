CREATE TABLE "scm_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"workspace" text,
	"auth_kind" text DEFAULT 'token' NOT NULL,
	"username" text,
	"token_enc" text NOT NULL,
	"token_name" text,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"missing_scopes" text[] DEFAULT '{}' NOT NULL,
	"scopes_verified" boolean DEFAULT true NOT NULL,
	"account_login" text DEFAULT '' NOT NULL,
	"account_id" text,
	"expires_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scm_webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"credential_id" integer NOT NULL,
	"provider" text NOT NULL,
	"external_hook_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"secret_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "scm_credential_id" integer;--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "web_url" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "scm_credentials" ADD CONSTRAINT "scm_credentials_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_credentials" ADD CONSTRAINT "scm_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_webhooks" ADD CONSTRAINT "scm_webhooks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_webhooks" ADD CONSTRAINT "scm_webhooks_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_webhooks" ADD CONSTRAINT "scm_webhooks_credential_id_scm_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."scm_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scm_credentials_org_id_index" ON "scm_credentials" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scm_webhooks_repo_uq" ON "scm_webhooks" USING btree ("repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scm_webhooks_secret_uq" ON "scm_webhooks" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "scm_webhooks_provider_external_hook_id_index" ON "scm_webhooks" USING btree ("provider","external_hook_id");--> statement-breakpoint
CREATE INDEX "scm_webhooks_org_id_index" ON "scm_webhooks" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_scm_credential_id_scm_credentials_id_fk" FOREIGN KEY ("scm_credential_id") REFERENCES "public"."scm_credentials"("id") ON DELETE cascade ON UPDATE no action;