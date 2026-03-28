import { describe, test, expect } from "vitest";
import { db } from "../src/db/db";
import { users, linkedDevices, deviceConfig, alerts } from "../src/db/schema";
import { eq } from "drizzle-orm";

describe("Database Operations", () => {
  test("should retrieve test user from database", async () => {
    const testUsers = await db
      .select()
      .from(users)
      .where(eq(users.email, "test@example.com"));

    expect(testUsers).toHaveLength(1);
    expect(testUsers[0]?.email).toBe("test@example.com");
    expect(testUsers[0]?.emailVerified).toBe(true);
  });

  test("should retrieve test device from database", async () => {
    const devices = await db.select().from(linkedDevices);

    expect(devices).toHaveLength(1);
    expect(devices[0]?.nickname).toBe("Test Device");
    expect(devices[0]?.parentId).toBe(1);
  });

  test("should create new user", async () => {
    const newUser = await db
      .insert(users)
      .values({
        email: "newuser@example.com",
        password: "hashedpassword",
        emailVerified: false,
        emailCode: "654321",
        pushTokens: ["token1", "token2"],
      })
      .returning();

    expect(newUser).toHaveLength(1);
    expect(newUser[0]?.email).toBe("newuser@example.com");
    expect(newUser[0]?.pushTokens).toEqual(["token1", "token2"]);
  });

  test("should create device config", async () => {
    const config = await db
      .insert(deviceConfig)
      .values({
        deviceId: 1,
        disableBuddy: false,
        blockAdultSites: true,
        familyLinkAntiCircumvention: true,
        blockStrangers: false,
        notifyDangerousMessages: true,
        notifyNewContactAdded: true,
      })
      .returning();

    expect(config).toHaveLength(1);
    expect(config[0]?.deviceId).toBe(1);
    expect(config[0]?.familyLinkAntiCircumvention).toBe(true);
  });

  test("should create alert", async () => {
    const alert = await db
      .insert(alerts)
      .values({
        deviceId: 1,
        parentId: 1,
        category: "test",
        title: "Test Alert",
        message: "This is a test alert",
        summary: "Test alert summary",
        confidence: 95,
        packageName: "com.test.app",
        timestamp: Math.floor(Date.now() / 1000),
        read: false,
      })
      .returning();

    expect(alert).toHaveLength(1);
    expect(alert[0]?.title).toBe("Test Alert");
    expect(alert[0]?.confidence).toBe(95);
  });

  test("should update device last online", async () => {
    const newTimestamp = Math.floor(Date.now() / 1000);

    await db
      .update(linkedDevices)
      .set({ lastOnline: newTimestamp })
      .where(eq(linkedDevices.id, 1));

    const device = await db
      .select()
      .from(linkedDevices)
      .where(eq(linkedDevices.id, 1))
      .limit(1);

    expect(device[0]?.lastOnline).toBe(newTimestamp);
  });
});
