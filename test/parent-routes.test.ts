import { describe, test, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import { db } from "../src/db/db";
import { linkedDevices, deviceConfig } from "../src/db/schema";
import { eq } from "drizzle-orm";
import createParentRouter from "../src/routes/parent";

vi.mock("../src/middleware/auth", () => ({
  authParent: (req: Request, res: Response, next: NextFunction) => {
    req.user = { id: 1, type: "parent" };
    next();
  },
}));

vi.mock("../src/notifications/push", () => ({
  isValidPushToken: vi.fn(() => true),
}));

describe("Parent Routes", () => {
  let app: express.Application;

  beforeEach(async () => {
    const onlineDevices = new Map();

    app = express();
    app.use(express.json());
    app.use("/", createParentRouter(onlineDevices));

    await db.delete(deviceConfig).execute();
  });

  test("should get devices for parent", async () => {
    const response = await request(app).get("/parent/devices").expect(200);

    expect(response.body.success).toBe(true);
    expect(Array.isArray(response.body.devices)).toBe(true);
  });

  test("should get device config", async () => {
    await db.insert(deviceConfig).values({
      deviceId: 1,
      disableBuddy: false,
      blockAdultSites: true,
      familyLinkAntiCircumvention: false,
      blockStrangers: false,
      notifyDangerousMessages: true,
      notifyNewContactAdded: true,
    });

    const response = await request(app).get("/parent/controls/1").expect(200);

    expect(response.body.success).toBe(true);
    expect(Array.isArray(response.body.safetyControls)).toBe(true);
    const adultSitesControl = response.body.safetyControls.find(
      (c: { key: string }) => c.key === "adult_sites",
    );
    expect(adultSitesControl.defaultValue).toBe(true);
  });

  test("should update device config", async () => {
    await db.insert(deviceConfig).values({
      deviceId: 1,
      disableBuddy: false,
      blockAdultSites: true,
      familyLinkAntiCircumvention: false,
      blockStrangers: false,
      notifyDangerousMessages: true,
      notifyNewContactAdded: true,
    });

    const response = await request(app)
      .post("/parent/controls/1")
      .send({
        key: "block_strangers",
        value: true,
      })
      .expect(200);

    expect(response.body.success).toBe(true);

    const config = await db
      .select()
      .from(deviceConfig)
      .where(eq(deviceConfig.deviceId, 1))
      .limit(1);

    expect(config[0]?.blockStrangers).toBe(true);
  });

  test("should rename device", async () => {
    const response = await request(app)
      .post("/parent/device/1/rename")
      .send({
        name: "Updated Device Name",
      })
      .expect(200);

    expect(response.body.success).toBe(true);

    const device = await db
      .select()
      .from(linkedDevices)
      .where(eq(linkedDevices.id, 1))
      .limit(1);

    expect(device[0]?.nickname).toBe("Updated Device Name");
  });

  test("should validate request body for config update", async () => {
    const response = await request(app)
      .post("/parent/controls/1")
      .send({
        key: "invalid_key",
        value: true,
      })
      .expect(400);

    expect(response.body.success).toBe(false);
  });

  test("should validate device ID parameter", async () => {
    const response = await request(app)
      .get("/parent/controls/invalid")
      .expect(400);

    expect(response.body.success).toBe(false);
  });
});
