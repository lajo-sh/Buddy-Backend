import {
  integer,
  pgTable,
  varchar,
  boolean,
  text,
  pgEnum,
} from "drizzle-orm/pg-core";
import { defineRelations, sql } from "drizzle-orm";

export const galleryScanningMode = pgEnum("galleryScanningMode", [
  "delete",
  "notify",
  "none",
]);

/** Parent user accounts with email auth and push notification tokens */
export const users = pgTable("users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  email: varchar({ length: 255 }).notNull().unique(),
  password: varchar({ length: 255 }).notNull(),
  emailVerified: boolean().default(false),
  emailCode: varchar({ length: 6 }).notNull(),
  pushTokens: text("push_tokens")
    .array()
    .default(sql`'{}'::text[]`),
});

/** Child devices linked to parent accounts for monitoring */
export const linkedDevices = pgTable("linkedDevices", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  nickname: varchar({ length: 255 }).notNull().default("New Device"),
  parentId: integer("parent_id").notNull(),
  lastOnline: integer("last_online"),

  devEnabled: boolean().default(false),
});

/** Safety and monitoring settings for each child device */
export const deviceConfig = pgTable("deviceConfig", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  deviceId: integer("device_id").notNull().unique(),
  disableBuddy: boolean("disable_buddy").notNull().default(false),
  blockAdultSites: boolean("block_adult_sites").notNull().default(true),
  familyLinkAntiCircumvention: boolean("family_link_anti_circumvention")
    .notNull()
    .default(false),
  blockStrangers: boolean("block_strangers").notNull().default(false),
  notifyDangerousMessages: boolean("notify_dangerous_messages")
    .notNull()
    .default(true),
  notifyNewContactAdded: boolean("notify_new_contact_added")
    .notNull()
    .default(true),
  galleryScanningMode: galleryScanningMode().default("notify").notNull(),
});

/** Stores flagged messages and content alerts for parent review */
export const alerts = pgTable("alerts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  deviceId: integer("device_id").notNull(),
  parentId: integer("parent_id").notNull(),
  category: varchar({ length: 50 }),
  title: varchar({ length: 255 }).notNull(),
  message: text().notNull(),
  summary: text().notNull(),
  confidence: integer().notNull(),
  packageName: varchar({ length: 255 }),
  timestamp: integer().notNull(),
  read: boolean().notNull().default(false),
});

export const relations = defineRelations(
  { users, linkedDevices, deviceConfig, alerts },
  (r) => ({
    users: {
      linkedDevices: r.many.linkedDevices(),
      alerts: r.many.alerts(),
    },
    linkedDevices: {
      parent: r.one.users({
        from: r.linkedDevices.parentId,
        to: r.users.id,
      }),
      config: r.one.deviceConfig({
        from: r.linkedDevices.id,
        to: r.deviceConfig.deviceId,
      }),
      alerts: r.many.alerts(),
    },
    deviceConfig: {
      device: r.one.linkedDevices({
        from: r.deviceConfig.deviceId,
        to: r.linkedDevices.id,
      }),
    },
    alerts: {
      parent: r.one.users({
        from: r.alerts.parentId,
        to: r.users.id,
      }),
      device: r.one.linkedDevices({
        from: r.alerts.deviceId,
        to: r.linkedDevices.id,
      }),
    },
  }),
);
