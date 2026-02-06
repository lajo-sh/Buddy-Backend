CREATE TABLE "deviceConfig" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deviceConfig_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"device_id" integer NOT NULL UNIQUE,
	"disable_buddy" boolean DEFAULT false NOT NULL,
	"block_adult_sites" boolean DEFAULT true NOT NULL,
	"content_filtering" boolean DEFAULT true NOT NULL,
	"new_contact_alerts" boolean DEFAULT true NOT NULL,
	"block_strangers" boolean DEFAULT false NOT NULL,
	"notify_dangerous_messages" boolean DEFAULT true NOT NULL,
	"notify_new_contact_added" boolean DEFAULT true NOT NULL
);
