CREATE TABLE "alerts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"device_id" integer NOT NULL,
	"parent_id" integer NOT NULL,
	"category" varchar(50),
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"summary" text NOT NULL,
	"confidence" integer NOT NULL,
	"packageName" varchar(255),
	"timestamp" integer NOT NULL,
	"read" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "push_tokens" text[] DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "push_token";