CREATE TYPE "public"."account_scope" AS ENUM('household', 'individual');--> statement-breakpoint
ALTER TABLE "reserve_accounts" ADD COLUMN "scope" "account_scope" DEFAULT 'household' NOT NULL;--> statement-breakpoint
ALTER TABLE "reserve_accounts" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "reserve_accounts" ADD CONSTRAINT "reserve_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserve_accounts" ADD CONSTRAINT "reserve_accounts_owner_matches_scope" CHECK (("reserve_accounts"."scope" = 'individual') = ("reserve_accounts"."owner_user_id" is not null));