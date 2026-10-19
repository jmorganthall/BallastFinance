-- Whose income (PRD D52): a household member, or a name typed for someone
-- outside the household. A member's name is read from users, never copied, so
-- `person` is empty when a member is chosen; the CHECK keeps one of the two.
ALTER TABLE "income_sources" ALTER COLUMN "person" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "income_sources" ADD COLUMN "person_user_id" uuid;--> statement-breakpoint
ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_person_user_id_users_id_fk" FOREIGN KEY ("person_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_whose" CHECK ("income_sources"."person_user_id" is not null or btrim("income_sources"."person") <> '');