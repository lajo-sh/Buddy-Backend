import express from "express";
import { authDevice } from "../middleware/auth";
import { db } from "../db/db";
import { deviceConfig } from "../db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../lib/pino";
import { z } from "zod";

/** Schema for validating device IDs from authenticated requests */
const DeviceIdSchema = z
  .number()
  .int()
  .positive("Device ID must be a positive integer");

const router: express.Router = express.Router();

router.get("/kid/getconfig", authDevice, async (req, res) => {
  const deviceId = req.user!.id;

  const parsed = DeviceIdSchema.safeParse(deviceId);
  if (!parsed.success) {
    logger.error(
      { deviceId, error: parsed.error },
      "Invalid device ID in getconfig request",
    );
    res.status(400).json({
      success: false,
      reason: parsed.error.issues[0]?.message || "Invalid device ID",
    });
    return;
  }

  try {
    let config;
    try {
      config = await db
        .select()
        .from(deviceConfig)
        .where(eq(deviceConfig.deviceId, deviceId))
        .limit(1);
    } catch (dbError) {
      logger.error(
        { error: dbError, deviceId },
        "Database error fetching device config",
      );
      throw dbError;
    }

    if (config.length === 0) {
      try {
        const newConfig = await db
          .insert(deviceConfig)
          .values({ deviceId })
          .returning();
        config = newConfig;
        logger.info({ deviceId }, "Created default device config");
      } catch (insertError) {
        logger.error(
          { error: insertError, deviceId },
          "Failed to create default device config",
        );
        throw insertError;
      }
    }

    const cfg = config[0];
    if (!cfg) {
      logger.error(
        { deviceId },
        "Config is unexpectedly undefined after creation",
      );
      res.status(500).json({
        success: false,
        reason: "Failed to get device configuration",
      });
      return;
    }

    logger.debug(
      {
        deviceId,
        config: {
          disableBuddy: cfg.disableBuddy,
          blockAdultSites: cfg.blockAdultSites,
        },
      },
      "Device config retrieved successfully",
    );

    res.json({
      success: true,
      config: {
        disableBuddy: cfg.disableBuddy,
        blockAdultSites: cfg.blockAdultSites,
        familyLinkAntiCircumvention: cfg.familyLinkAntiCircumvention,
        galleryScanningMode: cfg.galleryScanningMode,
      },
    });
  } catch (e) {
    logger.error({ error: e, deviceId }, "Failed to get device config");
    res.status(500).json({
      success: false,
      reason: "Failed to get device configuration",
    });
  }
});

export default router;
