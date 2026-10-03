CREATE TYPE "public"."org_llm_provider" AS ENUM('anthropic', 'openai', 'openrouter', 'openai-compatible');--> statement-breakpoint
CREATE TYPE "public"."sso_protocol" AS ENUM('oidc', 'saml');--> statement-breakpoint
CREATE TABLE "org_llm_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"provider" "org_llm_provider" NOT NULL,
	"base_url" text,
	"api_key_enc" text,
	"model" text,
	"task_models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"protocol" "sso_protocol" NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text,
	"client_secret_enc" text,
	"saml_sso_url" text,
	"saml_certificates" text[] DEFAULT '{}' NOT NULL,
	"allowed_domains" text[] DEFAULT '{}' NOT NULL,
	"default_role" "invite_role" DEFAULT 'member' NOT NULL,
	"enforce" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_saml_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"next" text DEFAULT '/dashboard' NOT NULL,
	"link_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sso_org_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_llm_settings" ADD CONSTRAINT "org_llm_settings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_llm_settings" ADD CONSTRAINT "org_llm_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_saml_requests" ADD CONSTRAINT "sso_saml_requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_saml_requests" ADD CONSTRAINT "sso_saml_requests_connection_id_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sso_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_saml_requests" ADD CONSTRAINT "sso_saml_requests_link_user_id_users_id_fk" FOREIGN KEY ("link_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sso_connections_org_id_index" ON "sso_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sso_saml_requests_expires_at_index" ON "sso_saml_requests" USING btree ("expires_at");