import "dotenv/config";

import express from "express";
import expressWs from "express-ws";
import type * as ws from "ws";

import signupRouter from "./routes/signup";
import signinRouter from "./routes/signin";
import kidRouter from "./routes/kid";
import parentRouter from "./routes/parent";

import * as jose from "jose";
import {
  notificationScanQueue,
  storeNotification,
  getRecentNotifications,
} from "./queue/notification_scan";
import {
  accessibilityScanQueue,
  storeAccessibilityMessage,
  getRecentAccessibilityMessages,
} from "./queue/accessibility_scan";
import "./queue/push_notification";
import { db } from "./db/db";
import { linkedDevices, deviceConfig, users, alerts } from "./db/schema";
import { eq } from "drizzle-orm";
import { pushNotificationQueue } from "./queue/push_notification";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/pino";

logger.info("Starting Buddy Backend server...");

const { app } = expressWs(express());

app.use(express.json());
app.use(pinoHttp({ logger }));

app.use("/", signupRouter);
app.use("/", signinRouter);
app.use("/", kidRouter);

/** Tracks which devices are currently connected via WebSocket */
const onlineDevices = new Map<number, { connectedAt: number }>();

interface ChildJwtPayload extends jose.JWTPayload {
  type: "child";
  id: number;
}

type KidWebSocket = ws.WebSocket & { deviceId: number | null };

app.use("/", parentRouter(onlineDevices));

app.ws("/kid/connect", (ws, req) => {
  logger.info({ ip: req.ip }, "New WebSocket connection to /kid/connect");

  (ws as unknown as KidWebSocket).deviceId = null;

  ws.on("message", async (msg) => {
    let data: Record<string, unknown> | undefined;
    try {
      data = JSON.parse(msg.toString()) as Record<string, unknown>;
    } catch {
      ws.send(JSON.stringify({ success: false, reason: "Invalid JSON" }));
      return;
    }

    console.log(data);

    if (data.type === "token") {
      try {
        const publicKey = process.env.JWT_PUBLIC_KEY!;
        const spki = await jose.importSPKI(publicKey, "RS256");
        const { payload } = await jose.jwtVerify(data.token as string, spki, {
          audience: "urn:buddy:devices",
          issuer: "urn:lajosh:buddy",
        });

        if ((payload as ChildJwtPayload).type !== "child") {
          ws.send(
            JSON.stringify({ success: false, reason: "Invalid token type" }),
          );
          return;
        }

        const deviceId = (payload as ChildJwtPayload).id;

        (ws as unknown as KidWebSocket).deviceId = deviceId;

        logger.info(
          { deviceId },
          "WebSocket client authenticated successfully",
        );

        onlineDevices.set(deviceId, { connectedAt: Date.now() });
        await db
          .update(linkedDevices)
          .set({ lastOnline: Math.floor(Date.now() / 1000) })
          .where(eq(linkedDevices.id, deviceId));

        ws.send(
          JSON.stringify({
            success: true,
            type: "token",
            message: "authenticated",
          }),
        );
      } catch {
        ws.send(JSON.stringify({ success: false, reason: "Invalid token" }));
      }

      return;
    }

    if (data.type === "notification") {
      const deviceId = (ws as unknown as KidWebSocket).deviceId;
      if (!deviceId) {
        ws.send(
          JSON.stringify({ success: false, reason: "Not authenticated" }),
        );
        return;
      }

      try {
        const notification = {
          title: data.title as string,
          message: data.message as string,
          packageName: data.packageName as string,
          timestamp: Math.floor(Date.now() / 1000),
        };

        // Store the notification in Redis with 72-hour TTL
        await storeNotification(deviceId, notification);

        // Get all recent notifications (last 72 hours) for context
        const recentNotifications = await getRecentNotifications(deviceId);

        await notificationScanQueue.add("scanNotification", {
          deviceId,
          notification,
          recentNotifications,
        });

        logger.info(
          {
            deviceId,
            packageName: data.packageName,
            contextNotificationsCount: recentNotifications.length,
          },
          "Notification queued for scanning with context",
        );

        ws.send(JSON.stringify({ success: true, todo: "queued" }));
      } catch (e) {
        logger.error({ error: e, deviceId }, "Failed to enqueue notification");
        ws.send(
          JSON.stringify({
            success: false,
            reason: "Failed to queue notification",
          }),
        );
      }

      return;
    }

    if (data.type === "status_ping") {
      const { dev_enabled } = data;

      const deviceId = (ws as unknown as KidWebSocket).deviceId;
      if (!deviceId) {
        ws.send(
          JSON.stringify({ success: false, reason: "Not authenticated" }),
        );
        return;
      }

      const userDevice = await db
        .select()
        .from(linkedDevices)
        .where(eq(linkedDevices.id, deviceId))
        .limit(1);

      const config = await db
        .select()
        .from(deviceConfig)
        .where(eq(deviceConfig.deviceId, deviceId))
        .limit(1);

      if (config.length > 0 && !config[0]!.familyLinkAntiCircumvention) {
        return;
      }

      if (userDevice[0]?.devEnabled === false && dev_enabled === true) {
        await db
          .update(linkedDevices)
          .set({ devEnabled: true })
          .where(eq(linkedDevices.id, deviceId));

        const device = await db
          .select()
          .from(linkedDevices)
          .where(eq(linkedDevices.id, deviceId))
          .limit(1);

        if (device.length > 0) {
          const parentId = device[0]!.parentId;
          const deviceName = device[0]!.nickname;

          const parent = await db
            .select({ pushTokens: users.pushTokens })
            .from(users)
            .where(eq(users.id, parentId))
            .limit(1);

          if (
            parent.length > 0 &&
            parent[0]!.pushTokens &&
            parent[0]!.pushTokens.length > 0
          ) {
            await pushNotificationQueue.add("dev-mode-enabled-alert", {
              pushTokens: parent[0]!.pushTokens,
              notification: {
                title: `⚠️ Possible circumvention attempt detected`,
                body: `Developer mode was enabled on ${deviceName}, allowing the use of ADB to kill Buddy and Family Link`,
                data: {
                  type: "dev_mode_enabled",
                  screen: "DeviceDetail",
                  deviceId: deviceId.toString(),
                  deviceName: deviceName,
                },
                channelId: "alerts",
              },
            });

            await db.insert(alerts).values({
              deviceId: deviceId,
              parentId: parentId,
              category: "circumvention",
              title: "Possible circumvention detected",
              message: `Developer mode was enabled on ${deviceName}`,
              summary: `Developer mode was enabled on ${deviceName}, allowing the use of ADB to kill Buddy and Family Link. This could be an attempt to bypass parental controls.`,
              confidence: 90,
              packageName: null,
              timestamp: Math.floor(Date.now() / 1000),
              read: false,
            });
          }
        }
      }

      if (userDevice[0]?.devEnabled === true && dev_enabled === false) {
        await db
          .update(linkedDevices)
          .set({ devEnabled: false })
          .where(eq(linkedDevices.id, deviceId));
      }

      return;
    }

    if (data.type === "contact_added") {
      logger.info("Contact added message received from device");
      const deviceId = (ws as unknown as KidWebSocket).deviceId;
      if (!deviceId) {
        ws.send(
          JSON.stringify({ success: false, reason: "Not authenticated" }),
        );
        return;
      }

      try {
        let contactType = "unknown";
        let contactIdentifier = "";

        if (
          data.phoneNumbers &&
          Array.isArray(data.phoneNumbers) &&
          data.phoneNumbers.length > 0
        ) {
          contactType = "phone";
          contactIdentifier = data.phoneNumbers.join(", ");
        } else if (
          data.emails &&
          Array.isArray(data.emails) &&
          data.emails.length > 0
        ) {
          contactType = "email";
          contactIdentifier = data.emails.join(", ");
        }

        const device = await db
          .select()
          .from(linkedDevices)
          .where(eq(linkedDevices.id, deviceId))
          .limit(1);

        if (device.length > 0) {
          const parentId = device[0]!.parentId;
          const deviceName = device[0]!.nickname;

          const config = await db
            .select()
            .from(deviceConfig)
            .where(eq(deviceConfig.deviceId, deviceId))
            .limit(1);

          const shouldNotify =
            config.length === 0 || config[0]!.notifyNewContactAdded;

          if (shouldNotify) {
            const parent = await db
              .select({ pushTokens: users.pushTokens })
              .from(users)
              .where(eq(users.id, parentId))
              .limit(1);

            if (
              parent.length > 0 &&
              parent[0]!.pushTokens &&
              parent[0]!.pushTokens.length > 0
            ) {
              await pushNotificationQueue.add("new-contact-alert", {
                pushTokens: parent[0]!.pushTokens,
                notification: {
                  title: `👤 New Contact Added`,
                  body: `${data.name} was added on ${deviceName}`,
                  data: {
                    type: "new_contact",
                    screen: "ContactDetail",
                    deviceId: deviceId.toString(),
                    deviceName: deviceName,
                    contactName: data.name,
                    contactIdentifier: contactIdentifier,
                    contactType,
                  },
                  channelId: "alerts",
                },
              });

              logger.info(
                { parentId, deviceId, contactName: data.name },
                "New contact notification queued for parent",
              );
            }
          }
        }

        ws.send(
          JSON.stringify({
            success: true,
          }),
        );
      } catch (e) {
        logger.error(
          { error: e, deviceId },
          "Failed to send contact notification",
        );
        ws.send(
          JSON.stringify({
            success: false,
            reason: "Failed to send notification",
          }),
        );
      }

      return;
    }

    if (data.type === "accessibility_message_detected") {
      const deviceId = (ws as unknown as KidWebSocket).deviceId;
      if (!deviceId) {
        ws.send(
          JSON.stringify({ success: false, reason: "Not authenticated" }),
        );
        return;
      }

      try {
        const accessibilityMessage = {
          app: data.app as string,
          sender: data.sender as string,
          message: data.message as string,
          timestamp:
            (data.timestamp as number) || Math.floor(Date.now() / 1000),
        };

        // Store the message in Redis with 72-hour TTL
        await storeAccessibilityMessage(deviceId, accessibilityMessage);

        // Get all recent messages (last 72 hours) for context
        const recentMessages = await getRecentAccessibilityMessages(deviceId);

        await accessibilityScanQueue.add("scanAccessibilityMessage", {
          deviceId,
          accessibilityMessage,
          recentMessages,
        });

        logger.info(
          {
            deviceId,
            app: data.app,
            sender: data.sender,
            contextMessagesCount: recentMessages.length,
          },
          "Accessibility message queued for scanning with context",
        );

        ws.send(JSON.stringify({ success: true, todo: "queued" }));
      } catch (e) {
        logger.error(
          { error: e, deviceId },
          "Failed to enqueue accessibility message",
        );
        ws.send(
          JSON.stringify({
            success: false,
            reason: "Failed to queue accessibility message",
          }),
        );
      }

      return;
    }

    if (data.type === "circumvention_event") {
      const deviceId = (ws as unknown as KidWebSocket).deviceId;
      if (!deviceId) {
        ws.send(
          JSON.stringify({ success: false, reason: "Not authenticated" }),
        );
        return;
      }

      try {
        const packageName = data.packageName as string;
        const className = data.className as string;

        const device = await db
          .select()
          .from(linkedDevices)
          .where(eq(linkedDevices.id, deviceId))
          .limit(1);

        if (device.length === 0) {
          logger.error(
            { deviceId },
            "Device not found for circumvention event",
          );
          ws.send(JSON.stringify({ success: true }));
          return;
        }

        const parentId = device[0]!.parentId;
        const deviceName = device[0]!.nickname;

        /** Maps circumvention event keys to their descriptions for parent alerts */
        const circumventionDescriptions: Record<
          string,
          { name: string; description: string }
        > = {
          "com.miui.securitycore:PrivateSpaceMainActivity": {
            name: "Xiaomi Second Space",
            description:
              "Second Space allows creating a separate, isolated environment on the device where apps can be hidden and run independently",
          },
        };

        const eventKey = `${packageName}:${className.split(".").pop()}`;
        const eventInfo = circumventionDescriptions[eventKey] || {
          name: "Circumvention Feature",
          description:
            "A feature that could be used to bypass parental controls was accessed",
        };

        const config = await db
          .select()
          .from(deviceConfig)
          .where(eq(deviceConfig.deviceId, deviceId))
          .limit(1);

        if (config.length > 0 && !config[0]!.familyLinkAntiCircumvention) {
          logger.info(
            { deviceId },
            "Family Link anti-circumvention disabled, skipping notification",
          );
          ws.send(JSON.stringify({ success: true }));
          return;
        }

        const parent = await db
          .select({ pushTokens: users.pushTokens })
          .from(users)
          .where(eq(users.id, parentId))
          .limit(1);

        if (
          parent.length > 0 &&
          parent[0]!.pushTokens &&
          parent[0]!.pushTokens.length > 0
        ) {
          await pushNotificationQueue.add("circumvention-event-alert", {
            pushTokens: parent[0]!.pushTokens,
            notification: {
              title: `⚠️ Circumvention Attempt Detected`,
              body: `${eventInfo.name} was accessed on ${deviceName}`,
              data: {
                type: "circumvention_event",
                screen: "DeviceDetail",
                deviceId: deviceId.toString(),
                deviceName: deviceName,
                featureName: eventInfo.name,
              },
              channelId: "alerts",
            },
          });

          await db.insert(alerts).values({
            deviceId: deviceId,
            parentId: parentId,
            category: "circumvention",
            title: `${eventInfo.name} accessed`,
            message: `${eventInfo.name} was accessed on ${deviceName}`,
            summary: eventInfo.description,
            confidence: 95,
            packageName: packageName,
            timestamp: Math.floor(Date.now() / 1000),
            read: false,
          });

          logger.info(
            { parentId, deviceId, featureName: eventInfo.name },
            "Circumvention event notification sent",
          );
        }

        ws.send(JSON.stringify({ success: true }));
      } catch (e) {
        logger.error(
          { error: e, deviceId },
          "Failed to process circumvention event",
        );
        ws.send(
          JSON.stringify({
            success: false,
            reason: "Failed to process circumvention event",
          }),
        );
      }

      return;
    }

    logger.debug(
      { data, deviceId: (ws as unknown as KidWebSocket).deviceId },
      "Unknown message type received",
    );

    ws.send(JSON.stringify({ success: false, reason: "Unknown message type" }));
  });

  ws.on("close", async () => {
    const deviceId = (ws as unknown as KidWebSocket).deviceId;
    if (deviceId) {
      logger.info({ deviceId }, "WebSocket connection closed");
      onlineDevices.delete(deviceId);
      await db
        .update(linkedDevices)
        .set({ lastOnline: Math.floor(Date.now() / 1000) })
        .where(eq(linkedDevices.id, deviceId));
    }
  });
});

app.listen(3000, () => {
  logger.info({ port: 3000 }, "Buddy Backend server is running");
});
