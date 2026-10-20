CREATE TYPE "public"."api_key_mode" AS ENUM('live', 'test');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."gateway_status" AS ENUM('unbound', 'bound', 'site_reset_pending', 'factory_reset_pending');--> statement-breakpoint
CREATE TYPE "public"."pairing_status" AS ENUM('queued', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('installer', 'resident', 'operator');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"api_key_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"mode" "api_key_mode" NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"expiring_notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"org_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"data" jsonb,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"gateway_id" text NOT NULL,
	"local_id" text NOT NULL,
	"site_id" text,
	"name" text NOT NULL,
	"room" text,
	"device_type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"vendor" text,
	"model" text,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_gateway_local_uq" UNIQUE("gateway_id","local_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"gateway_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"sub" integer DEFAULT 0 NOT NULL,
	"site_id" text,
	"site_epoch" integer,
	"key_version" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replayed" boolean DEFAULT false NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "events_gateway_boot_seq_sub_uq" UNIQUE("gateway_id","boot_id","seq","sub")
);
--> statement-breakpoint
CREATE TABLE "gateways" (
	"gateway_id" text PRIMARY KEY NOT NULL,
	"short_id" text NOT NULL,
	"org_id" text NOT NULL,
	"site_id" text,
	"status" "gateway_status" DEFAULT 'unbound' NOT NULL,
	"pubkey" text NOT NULL,
	"token_hash" text,
	"cfg_version" integer DEFAULT 0 NOT NULL,
	"cfg_acked_version" integer DEFAULT 0 NOT NULL,
	"key_version" integer DEFAULT 0 NOT NULL,
	"claim_window_until" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"boot_id" text,
	"agent_version" text,
	"matter_server_version" text,
	"online" boolean DEFAULT false NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"org_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pairing_sessions" (
	"pairing_session_id" text PRIMARY KEY NOT NULL,
	"gateway_id" text NOT NULL,
	"site_id" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"code_enc" text,
	"name" text,
	"status" "pairing_status" DEFAULT 'queued' NOT NULL,
	"stage" text,
	"error_code" text,
	"error" text,
	"local_session_id" text,
	"device_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "site_keys" (
	"site_id" text NOT NULL,
	"version" integer NOT NULL,
	"key_enc" text NOT NULL,
	"epoch" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "site_keys_site_id_version_pk" PRIMARY KEY("site_id","version")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"site_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"epoch" integer DEFAULT 1 NOT NULL,
	"owner_user_id" text,
	"created_by_user_id" text,
	"handed_over_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"role" "user_role" NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"webhook_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_event_webhook_uq" UNIQUE("event_id","webhook_id")
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"webhook_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"url" text NOT NULL,
	"secret_enc" text NOT NULL,
	"events" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_gateway_id_gateways_gateway_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."gateways"("gateway_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_site_id_sites_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_gateway_id_gateways_gateway_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."gateways"("gateway_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_site_id_sites_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_site_id_sites_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_sessions" ADD CONSTRAINT "pairing_sessions_gateway_id_gateways_gateway_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."gateways"("gateway_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_sessions" ADD CONSTRAINT "pairing_sessions_site_id_sites_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_sessions" ADD CONSTRAINT "pairing_sessions_requested_by_user_id_users_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_keys" ADD CONSTRAINT "site_keys_site_id_sites_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("site_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_owner_user_id_users_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_created_by_user_id_users_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_webhook_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("webhook_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("hash");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_uq" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_org_idx" ON "audit_log" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "devices_site_idx" ON "devices" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "events_site_epoch_idx" ON "events" USING btree ("site_id","site_epoch","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gateways_short_id_uq" ON "gateways" USING btree ("short_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gateways_token_hash_uq" ON "gateways" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "gateways_site_idx" ON "gateways" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "gateways_org_idx" ON "gateways" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "pairing_sessions_gateway_status_idx" ON "pairing_sessions" USING btree ("gateway_id","status","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sites_org_idx" ON "sites" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sites_owner_idx" ON "sites" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_at");--> statement-breakpoint
CREATE INDEX "webhooks_org_idx" ON "webhooks" USING btree ("org_id");