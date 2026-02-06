CREATE TABLE "linkedDevices" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "linkedDevices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"nickname" varchar(255) DEFAULT 'New Device' NOT NULL,
	"parent_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email" varchar(255) NOT NULL UNIQUE,
	"password" varchar(255) NOT NULL,
	"emailVerified" boolean DEFAULT false,
	"emailCode" varchar(6) NOT NULL
);
