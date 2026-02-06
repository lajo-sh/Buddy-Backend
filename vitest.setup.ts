import { vi } from "vitest";
import { users, linkedDevices } from "./src/db/schema";
import * as schema from "./src/db/schema";

process.env.DATABASE_URL = "test-db";
process.env.JWT_PUBLIC_KEY = "test-key";
process.env.JWT_PRIVATE_KEY = "test-key";

vi.mock("./src/db/db", async () => {
  const { PGlite } = await vi.importActual<
    typeof import("@electric-sql/pglite")
  >("@electric-sql/pglite");
  const { drizzle } =
    await vi.importActual<typeof import("drizzle-orm/pglite")>(
      "drizzle-orm/pglite",
    );

  const client = new PGlite();

  const db = drizzle({ client, schema });

  await client.exec(`
    CREATE TABLE IF NOT EXISTS "users" (
      "id" SERIAL PRIMARY KEY,
      "email" VARCHAR(255) NOT NULL UNIQUE,
      "password" VARCHAR(255) NOT NULL,
      "emailVerified" BOOLEAN DEFAULT false,
      "emailCode" VARCHAR(6) NOT NULL,
      "push_tokens" TEXT[] DEFAULT '{}'
    );
    
    CREATE TABLE IF NOT EXISTS "linkedDevices" (
      "id" SERIAL PRIMARY KEY,
      "nickname" VARCHAR(255) NOT NULL DEFAULT 'New Device',
      "parent_id" INTEGER NOT NULL,
      "last_online" INTEGER,
      "devEnabled" BOOLEAN DEFAULT false
    );
    
    CREATE TABLE IF NOT EXISTS "deviceConfig" (
      "id" SERIAL PRIMARY KEY,
      "device_id" INTEGER NOT NULL UNIQUE,
      "disable_buddy" BOOLEAN NOT NULL DEFAULT false,
      "block_adult_sites" BOOLEAN NOT NULL DEFAULT true,
      "family_link_anti_circumvention" BOOLEAN NOT NULL DEFAULT false,
      "new_contact_alerts" BOOLEAN NOT NULL DEFAULT true,
      "block_strangers" BOOLEAN NOT NULL DEFAULT false,
      "notify_dangerous_messages" BOOLEAN NOT NULL DEFAULT true,
      "notify_new_contact_added" BOOLEAN NOT NULL DEFAULT true
    );
    
    CREATE TABLE IF NOT EXISTS "alerts" (
      "id" SERIAL PRIMARY KEY,
      "device_id" INTEGER NOT NULL,
      "parent_id" INTEGER NOT NULL,
      "category" VARCHAR(50),
      "title" VARCHAR(255),
      "message" TEXT,
      "summary" TEXT,
      "confidence" INTEGER,
      "packageName" VARCHAR(255),
      "timestamp" INTEGER NOT NULL,
      "read" BOOLEAN DEFAULT false
    );
  `);

  await db.insert(users).values({
    email: "test@example.com",
    password: "$argon2id$v=19$m=65536,t=3,p=4$test",
    emailVerified: true,
    emailCode: "123456",
    pushTokens: [],
  });

  await db.insert(linkedDevices).values({
    nickname: "Test Device",
    parentId: 1,
    lastOnline: Math.floor(Date.now() / 1000),
    devEnabled: false,
  });

  return { db };
});

vi.mock("./src/db/redis/client", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    pipeline: vi.fn(() => ({
      set: vi.fn(),
      del: vi.fn(),
      exec: vi.fn(),
    })),
    sadd: vi.fn(),
    smembers: vi.fn(() => []),
  },
}));

vi.mock("./src/lib/pino", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));
