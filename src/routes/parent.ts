import express from "express";
import { authParent } from "../middleware/auth";
import { db } from "../db/db";
import { deviceConfig, linkedDevices, users, alerts } from "../db/schema";
import { eq, and, desc } from "drizzle-orm";
import { isValidPushToken } from "../notifications/push";
import { logger } from "../lib/pino";
import { z } from "zod";

/** Validates email verification code from user input */
const VerifyEmailSchema = z.object({
  code: z.string().min(1, "Verification code cannot be empty"),
});

/** Validates device ID from URL parameters */
const DeviceIdParamSchema = z.object({
  deviceId: z.string().regex(/^\d+$/, "Device ID must be numeric"),
});

/** Validates control settings updates with allowed keys and boolean values */
const ControlsUpdateSchema = z.object({
  key: z.enum([
    "disable_buddy",
    "adult_sites",
    "new_people",
    "block_strangers",
    "notify_dangerous_messages",
    "notify_new_contact_added",
    "family_link_anti_circumvention",
  ]),
  value: z.boolean(),
});

/** Validates device nickname changes */
const DeviceRenameSchema = z.object({
  name: z.string().min(1, "Name cannot be empty").max(255, "Name too long"),
});

/** Validates push notification token format */
const PushTokenSchema = z.object({
  token: z.string().min(1, "Token cannot be empty"),
});

function createParentRouter(
  onlineDevices: Map<number, { connectedAt: number }>,
) {
  const router: express.Router = express.Router();

  /**
   * Converts a Unix timestamp to a human-readable relative time string.
   * Returns things like "Just now", "5m ago", "2d ago", etc.
   */
  const formatLastOnline = (timestamp: number | null | undefined): string => {
    if (!timestamp) return "Never";
    const lastOnlineDate = new Date(timestamp * 1000);
    const now = new Date();
    const diffMs = now.getTime() - lastOnlineDate.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return lastOnlineDate.toLocaleDateString();
  };

  router.post("/parent/verifyemail", authParent, async (req, res) => {
    const parentId = req.user!.id;

    const parsed = VerifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn(
        { parentId, error: parsed.error },
        "Invalid verification code in request",
      );
      return res.status(400).json({
        success: false,
        reason: parsed.error.issues[0]?.message || "Invalid verification code",
      });
    }

    const { code } = parsed.data;

    try {
      const user = await db
        .select()
        .from(users)
        .where(eq(users.id, parentId))
        .limit(1);

      if (user.length === 0) {
        logger.warn({ parentId }, "User not found for email verification");
        return res
          .status(404)
          .json({ success: false, reason: "User not found" });
      }

      const storedCode = user[0]!.emailCode;
      if (!storedCode) {
        logger.warn({ parentId }, "No verification code set for user");
        return res
          .status(400)
          .json({ success: false, reason: "No verification code set" });
      }

      if (storedCode !== code) {
        logger.warn({ parentId }, "Incorrect email verification code");
        return res
          .status(400)
          .json({ success: false, reason: "Incorrect verification code" });
      }

      try {
        await db
          .update(users)
          .set({ emailVerified: true })
          .where(eq(users.id, parentId));
        logger.info({ parentId }, "Email verified successfully");
        return res.json({ success: true });
      } catch (updateError) {
        logger.error(
          { error: updateError, parentId },
          "Database error updating email verification",
        );
        throw updateError;
      }
    } catch (e) {
      logger.error({ error: e, parentId }, "Failed to verify email");
      return res
        .status(500)
        .json({ success: false, reason: "Failed to verify email" });
    }
  });

  router.get("/parent/profile", authParent, async (req, res) => {
    const parentId = req.user!.id;

    try {
      const user = await db
        .select({
          email: users.email,
          emailVerified: users.emailVerified,
        })
        .from(users)
        .where(eq(users.id, parentId))
        .limit(1);

      if (user.length === 0) {
        logger.warn({ parentId }, "User not found for profile request");
        return res
          .status(404)
          .json({ success: false, reason: "User not found" });
      }

      logger.debug({ parentId }, "Profile retrieved successfully");
      return res.json({
        success: true,
        profile: {
          email: user[0]!.email,
          emailVerified: user[0]!.emailVerified ?? false,
        },
      });
    } catch (e) {
      logger.error({ error: e, parentId }, "Failed to get profile");
      return res
        .status(500)
        .json({ success: false, reason: "Failed to get profile" });
    }
  });

  router.get("/parent/devices", authParent, async (req, res) => {
    const parentId = req.user!.id;

    if (!parentId || typeof parentId !== "number") {
      logger.error({ parentId }, "Invalid parent ID in devices request");
      res.status(400).json({
        success: false,
        reason: "Invalid parent ID",
      });
      return;
    }

    try {
      const devices = await db
        .select()
        .from(linkedDevices)
        .where(eq(linkedDevices.parentId, parentId));

      logger.debug(
        { parentId, deviceCount: devices.length },
        "Retrieved parent devices",
      );

      res.json({
        success: true,
        devices: devices.map((d) => ({
          id: d.id.toString(),
          name: d.nickname,
          status: onlineDevices.has(d.id) ? "online" : "offline",
          lastCheck: formatLastOnline(d.lastOnline),
        })),
      });
    } catch (e) {
      logger.error({ error: e, parentId }, "Failed to get devices");
      res.status(500).json({
        success: false,
        reason: "Failed to get devices",
      });
    }
  });

  router.get("/parent/controls/:deviceId", authParent, async (req, res) => {
    const parentId = req.user!.id;

    const paramsParsed = DeviceIdParamSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      logger.warn(
        { deviceId: req.params.deviceId, parentId, error: paramsParsed.error },
        "Invalid device ID in controls request",
      );
      res.status(400).json({
        success: false,
        reason: "Invalid device ID",
      });
      return;
    }

    const deviceId = parseInt(paramsParsed.data.deviceId);

    try {
      // Verify the device belongs to this parent
      let device;
      try {
        device = await db
          .select()
          .from(linkedDevices)
          .where(
            and(
              eq(linkedDevices.id, deviceId),
              eq(linkedDevices.parentId, parentId),
            ),
          )
          .limit(1);
      } catch (dbError) {
        logger.error(
          { error: dbError, deviceId, parentId },
          "Database error verifying device ownership",
        );
        throw dbError;
      }

      if (device.length === 0) {
        logger.warn(
          { deviceId, parentId },
          "Device not found or does not belong to parent",
        );
        res.status(404).json({
          success: false,
          reason: "Device not found",
        });
        return;
      }

      // Get or create config for this device
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
        // Create default config for new device
        try {
          const newConfig = await db
            .insert(deviceConfig)
            .values({ deviceId })
            .returning();
          config = newConfig;
          logger.info({ deviceId }, "Created default config for device");
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
        logger.error({ deviceId }, "Config is unexpectedly undefined");
        res.status(500).json({
          success: false,
          reason: "Failed to get controls",
        });
        return;
      }

      logger.debug(
        { deviceId, parentId },
        "Device controls retrieved successfully",
      );

      res.json({
        success: true,
        safetyControls: [
          {
            key: "disable_buddy",
            title: "Disable Buddy",
            description: "Temporarily disable Buddy",
            defaultValue: cfg.disableBuddy,
          },
          {
            key: "adult_sites",
            title: "Adult sites",
            description: "Block adult websites.",
            defaultValue: cfg.blockAdultSites,
          },
          {
            key: "family_link_anti_circumvention",
            title: "Anti-Circumvention",
            description: "Prevent disabling of Family Link protections.",
            defaultValue: cfg.familyLinkAntiCircumvention,
          },
          {
            key: "new_people",
            title: "New contact alerts",
            description: "Get notified when your child chats with someone new.",
            defaultValue: cfg.newContactAlerts,
          },
          {
            key: "block_strangers",
            title: "Block communications with strangers",
            description: "Block or scan communications with strangers.",
            defaultValue: cfg.blockStrangers,
          },
          {
            key: "notify_dangerous_messages",
            title: "Dangerous messages notifications",
            description: "Notify when messages are potentially dangerous.",
            defaultValue: cfg.notifyDangerousMessages,
          },
          {
            key: "notify_new_contact_added",
            title: "New contact added notifications",
            description: "Notify when a new contact is added.",
            defaultValue: cfg.notifyNewContactAdded,
          },
        ],
      });
    } catch (e) {
      logger.error({ error: e, deviceId, parentId }, "Failed to get controls");
      res.status(500).json({
        success: false,
        reason: "Failed to get controls",
      });
    }
  });

  // Update a safety control for a specific device
  router.post("/parent/controls/:deviceId", authParent, async (req, res) => {
    const parentId = req.user!.id;

    const paramsParsed = DeviceIdParamSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      logger.warn(
        { deviceId: req.params.deviceId, parentId, error: paramsParsed.error },
        "Invalid device ID in controls update",
      );
      res.status(400).json({
        success: false,
        reason: "Invalid device ID",
      });
      return;
    }

    const bodyParsed = ControlsUpdateSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      logger.warn(
        { body: req.body, parentId, error: bodyParsed.error },
        "Invalid request body for controls update",
      );
      res.status(400).json({
        success: false,
        reason: bodyParsed.error.issues[0]?.message || "Invalid request body",
      });
      return;
    }

    const deviceId = parseInt(paramsParsed.data.deviceId);
    const { key, value } = bodyParsed.data;

    // Map frontend keys to database columns
    const keyMap: Record<string, keyof typeof deviceConfig.$inferSelect> = {
      disable_buddy: "disableBuddy",
      adult_sites: "blockAdultSites",
      new_people: "newContactAlerts",
      block_strangers: "blockStrangers",
      notify_dangerous_messages: "notifyDangerousMessages",
      notify_new_contact_added: "notifyNewContactAdded",
      family_link_anti_circumvention: "familyLinkAntiCircumvention",
    };

    const dbKey = keyMap[key];
    if (!dbKey) {
      logger.warn({ key, deviceId, parentId }, "Unknown control key");
      res.status(400).json({
        success: false,
        reason: "Unknown control key",
      });
      return;
    }

    try {
      // Verify the device belongs to this parent
      let device;
      try {
        device = await db
          .select()
          .from(linkedDevices)
          .where(
            and(
              eq(linkedDevices.id, deviceId),
              eq(linkedDevices.parentId, parentId),
            ),
          )
          .limit(1);
      } catch (dbError) {
        logger.error(
          { error: dbError, deviceId, parentId },
          "Database error verifying device ownership for control update",
        );
        throw dbError;
      }

      if (device.length === 0) {
        logger.warn(
          { deviceId, parentId },
          "Device not found for control update",
        );
        res.status(404).json({
          success: false,
          reason: "Device not found",
        });
        return;
      }

      // Ensure config exists
      let existingConfig;
      try {
        existingConfig = await db
          .select()
          .from(deviceConfig)
          .where(eq(deviceConfig.deviceId, deviceId))
          .limit(1);
      } catch (dbError) {
        logger.error(
          { error: dbError, deviceId },
          "Database error fetching config for update",
        );
        throw dbError;
      }

      if (existingConfig.length === 0) {
        try {
          await db.insert(deviceConfig).values({ deviceId });
          logger.info(
            { deviceId },
            "Created default config for control update",
          );
        } catch (insertError) {
          logger.error(
            { error: insertError, deviceId },
            "Failed to create config for control update",
          );
          throw insertError;
        }
      }

      // Update the specific field
      try {
        await db
          .update(deviceConfig)
          .set({ [dbKey]: value })
          .where(eq(deviceConfig.deviceId, deviceId));
        logger.info(
          { deviceId, key, value, dbKey },
          "Device control updated successfully",
        );
      } catch (updateError) {
        logger.error(
          { error: updateError, deviceId, key, value },
          "Database error updating control",
        );
        throw updateError;
      }

      res.json({
        success: true,
      });
    } catch (e) {
      logger.error(
        { error: e, deviceId, parentId, key },
        "Failed to update control",
      );
      res.status(500).json({
        success: false,
        reason: "Failed to update control",
      });
    }
  });

  // Rename a device
  router.post(
    "/parent/device/:deviceId/rename",
    authParent,
    async (req, res) => {
      const parentId = req.user!.id;

      const paramsParsed = DeviceIdParamSchema.safeParse(req.params);
      if (!paramsParsed.success) {
        logger.warn(
          {
            deviceId: req.params.deviceId,
            parentId,
            error: paramsParsed.error,
          },
          "Invalid device ID in rename request",
        );
        return res
          .status(400)
          .json({ success: false, reason: "Invalid device ID" });
      }

      const bodyParsed = DeviceRenameSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        logger.warn(
          { body: req.body, parentId, error: bodyParsed.error },
          "Invalid name in rename request",
        );
        return res.status(400).json({
          success: false,
          reason: bodyParsed.error.issues[0]?.message || "Invalid name",
        });
      }

      const deviceId = parseInt(paramsParsed.data.deviceId);
      const { name } = bodyParsed.data;

      try {
        // Verify the device belongs to this parent
        let device;
        try {
          device = await db
            .select()
            .from(linkedDevices)
            .where(
              and(
                eq(linkedDevices.id, deviceId),
                eq(linkedDevices.parentId, parentId),
              ),
            )
            .limit(1);
        } catch (dbError) {
          logger.error(
            { error: dbError, deviceId, parentId },
            "Database error verifying device ownership for rename",
          );
          throw dbError;
        }

        if (device.length === 0) {
          logger.warn({ deviceId, parentId }, "Device not found for rename");
          return res
            .status(404)
            .json({ success: false, reason: "Device not found" });
        }

        // Update the device name
        try {
          await db
            .update(linkedDevices)
            .set({ nickname: name })
            .where(eq(linkedDevices.id, deviceId));
          logger.info(
            { deviceId, oldName: device[0]!.nickname, newName: name },
            "Device renamed successfully",
          );
        } catch (updateError) {
          logger.error(
            { error: updateError, deviceId, name },
            "Database error renaming device",
          );
          throw updateError;
        }

        res.json({ success: true });
      } catch (e) {
        logger.error(
          { error: e, deviceId, parentId },
          "Failed to rename device",
        );
        res
          .status(500)
          .json({ success: false, reason: "Failed to rename device" });
      }
    },
  );

  // Get home dashboard data
  router.get("/parent/home", authParent, async (req, res) => {
    const parentId = req.user!.id;

    try {
      // Get linked devices count
      let devices;
      try {
        devices = await db
          .select()
          .from(linkedDevices)
          .where(eq(linkedDevices.parentId, parentId));
      } catch (dbError) {
        logger.error(
          { error: dbError, parentId },
          "Database error fetching devices for home dashboard",
        );
        throw dbError;
      }

      // Check if any device is online
      const anyDeviceOnline = devices.some((d) => onlineDevices.has(d.id));

      logger.debug(
        { parentId, deviceCount: devices.length, anyDeviceOnline },
        "Home dashboard data retrieved",
      );

      // TODO: Add alerts table and query real alert stats
      res.json({
        success: true,
        overallStatus: "all_clear",
        deviceOnline: anyDeviceOnline,
        alertStats: {
          last24Hours: 0,
          thisWeekReviewed: 0,
        },
      });
    } catch (e) {
      logger.error({ error: e, parentId }, "Failed to get home data");
      res.status(500).json({
        success: false,
        reason: "Failed to get home data",
      });
    }
  });

  // Get home dashboard data for a specific device
  router.get("/parent/home/:deviceId", authParent, async (req, res) => {
    const parentId = req.user!.id;

    const paramsParsed = DeviceIdParamSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      logger.warn(
        { deviceId: req.params.deviceId, parentId, error: paramsParsed.error },
        "Invalid device ID in home request",
      );
      res.status(400).json({
        success: false,
        reason: "Invalid device ID",
      });
      return;
    }

    const deviceId = parseInt(paramsParsed.data.deviceId);

    try {
      // Verify the device belongs to this parent
      let device;
      try {
        device = await db
          .select()
          .from(linkedDevices)
          .where(
            and(
              eq(linkedDevices.id, deviceId),
              eq(linkedDevices.parentId, parentId),
            ),
          )
          .limit(1);
      } catch (dbError) {
        logger.error(
          { error: dbError, deviceId, parentId },
          "Database error fetching device for home data",
        );
        throw dbError;
      }

      if (device.length === 0) {
        logger.warn({ deviceId, parentId }, "Device not found for home data");
        res.status(404).json({
          success: false,
          reason: "Device not found",
        });
        return;
      }

      // Check if this device is online using in-memory tracking
      const isDeviceOnline = onlineDevices.has(deviceId);

      logger.debug(
        { deviceId, parentId, isDeviceOnline },
        "Device home data retrieved",
      );

      // TODO: Add alerts table and query real alert stats for this device
      res.json({
        success: true,
        overallStatus: "all_clear",
        deviceOnline: isDeviceOnline,
        alertStats: {
          last24Hours: 0,
          thisWeekReviewed: 0,
        },
      });
    } catch (e) {
      logger.error(
        { error: e, deviceId, parentId },
        "Failed to get device home data",
      );
      res.status(500).json({
        success: false,
        reason: "Failed to get home data",
      });
    }
  });

  // Get activity data
  router.get("/parent/activity", authParent, async (req, res) => {
    // TODO: Implement real activity tracking
    res.json({
      success: true,
      period: "Last 7 days",
      metrics: [
        {
          id: "messaging",
          icon: "chatbubbles",
          title: "Messaging activity",
          description: "About the same as usual",
          level: "Normal",
        },
        {
          id: "new_people",
          icon: "people",
          title: "New people",
          description: "No new contacts",
          level: "Low",
        },
        {
          id: "late_night",
          icon: "time",
          title: "Late-night use",
          description: "No late night activity",
          level: "Normal",
        },
      ],
    });
  });

  // Register push notification token
  router.post("/parent/push-token", authParent, async (req, res) => {
    const parentId = req.user!.id;

    const parsed = PushTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn(
        { parentId, error: parsed.error },
        "Invalid push token in registration request",
      );
      res.status(400).json({
        success: false,
        reason: parsed.error.issues[0]?.message || "Invalid push token",
      });
      return;
    }

    const { token } = parsed.data;

    // Validate Expo push token format
    if (!isValidPushToken(token)) {
      logger.warn({ parentId, token }, "Invalid Expo push token format");
      res.status(400).json({
        success: false,
        reason: "Invalid Expo push token format",
      });
      return;
    }

    try {
      // Get current tokens
      let user;
      try {
        user = await db
          .select({ pushTokens: users.pushTokens })
          .from(users)
          .where(eq(users.id, parentId))
          .limit(1);
      } catch (dbError) {
        logger.error(
          { error: dbError, parentId },
          "Database error fetching user for push token",
        );
        throw dbError;
      }

      if (user.length === 0) {
        logger.error(
          { parentId },
          "User not found for push token registration",
        );
        res.status(404).json({
          success: false,
          reason: "User not found",
        });
        return;
      }

      const currentTokens = user[0]!.pushTokens || [];

      // Only add if not already present
      if (!currentTokens.includes(token)) {
        const updatedTokens = [...currentTokens, token];
        try {
          await db
            .update(users)
            .set({ pushTokens: updatedTokens })
            .where(eq(users.id, parentId));
          logger.info(
            { parentId, tokenCount: updatedTokens.length },
            "Push token registered successfully",
          );
        } catch (updateError) {
          logger.error(
            { error: updateError, parentId },
            "Database error updating push tokens",
          );
          throw updateError;
        }
      } else {
        logger.debug({ parentId }, "Push token already registered");
      }

      res.json({ success: true });
    } catch (e) {
      logger.error({ error: e, parentId }, "Failed to save push token");
      res.status(500).json({
        success: false,
        reason: "Failed to save push token",
      });
    }
  });

  // Remove push notification token
  router.delete("/parent/push-token", authParent, async (req, res) => {
    const parentId = req.user!.id;

    const parsed = PushTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn(
        { parentId, error: parsed.error },
        "Invalid push token in removal request",
      );
      res.status(400).json({
        success: false,
        reason: parsed.error.issues[0]?.message || "Invalid push token",
      });
      return;
    }

    const { token } = parsed.data;

    try {
      // Get current tokens
      let user;
      try {
        user = await db
          .select({ pushTokens: users.pushTokens })
          .from(users)
          .where(eq(users.id, parentId))
          .limit(1);
      } catch (dbError) {
        logger.error(
          { error: dbError, parentId },
          "Database error fetching user for push token removal",
        );
        throw dbError;
      }

      if (user.length === 0) {
        logger.error({ parentId }, "User not found for push token removal");
        res.status(404).json({
          success: false,
          reason: "User not found",
        });
        return;
      }

      const currentTokens = user[0]!.pushTokens || [];
      const updatedTokens = currentTokens.filter((t) => t !== token);

      try {
        await db
          .update(users)
          .set({ pushTokens: updatedTokens })
          .where(eq(users.id, parentId));
        logger.info(
          {
            parentId,
            removedToken: currentTokens.includes(token),
            tokenCount: updatedTokens.length,
          },
          "Push token removal processed",
        );
      } catch (updateError) {
        logger.error(
          { error: updateError, parentId },
          "Database error removing push token",
        );
        throw updateError;
      }

      res.json({ success: true });
    } catch (e) {
      logger.error({ error: e, parentId }, "Failed to remove push token");
      res.status(500).json({
        success: false,
        reason: "Failed to remove push token",
      });
    }
  });

  // Get alerts for the parent
  router.get("/parent/alerts", authParent, async (req, res) => {
    const parentId = req.user!.id;

    try {
      let parentAlerts;
      try {
        parentAlerts = await db
          .select({
            id: alerts.id,
            deviceId: alerts.deviceId,
            deviceName: linkedDevices.nickname,
            category: alerts.category,
            title: alerts.title,
            message: alerts.message,
            summary: alerts.summary,
            confidence: alerts.confidence,
            packageName: alerts.packageName,
            timestamp: alerts.timestamp,
            read: alerts.read,
          })
          .from(alerts)
          .innerJoin(linkedDevices, eq(alerts.deviceId, linkedDevices.id))
          .where(eq(alerts.parentId, parentId))
          .orderBy(desc(alerts.timestamp));
      } catch (dbError) {
        logger.error(
          { error: dbError, parentId },
          "Database error fetching alerts",
        );
        throw dbError;
      }

      const formatTimeLabel = (timestamp: number): string => {
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 1000 / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 1) return "Just now";
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString();
      };

      const formattedAlerts = parentAlerts.map((alert) => ({
        id: alert.id.toString(),
        title: alert.title,
        timeLabel: formatTimeLabel(alert.timestamp),
        whatHappened: `${alert.packageName || "An app"} on ${
          alert.deviceName
        } received: "${alert.message}"`,
        whyItMatters: alert.summary,
        suggestedAction:
          alert.category === "sexual_predator"
            ? "This requires immediate attention. Consider reviewing the device's activity and having a conversation with your child about online safety."
            : alert.category === "grooming"
              ? "Review this message carefully and discuss online safety with your child. Consider limiting contact with unknown individuals."
              : "Monitor this activity and discuss appropriate online behavior with your child.",
        severity: (alert.confidence >= 80 ? "needs_attention" : "gentle") as
          | "needs_attention"
          | "gentle",
      }));

      logger.debug(
        { parentId, alertCount: formattedAlerts.length },
        "Alerts retrieved successfully",
      );

      res.json({
        success: true,
        alerts: formattedAlerts,
      });
    } catch (e) {
      logger.error({ error: e, parentId }, "Failed to fetch alerts");
      res.status(500).json({
        success: false,
        reason: "Failed to fetch alerts",
      });
    }
  });

  return router;
}

export default createParentRouter;
