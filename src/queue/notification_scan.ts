import { Queue, Worker } from "bullmq";
import { connection } from "../db/redis/info";
import { redis } from "../db/redis/client";
import { model } from "../ai/ai";
import { generateObject } from "ai";
import { z } from "zod";
import { db } from "../db/db";
import { linkedDevices, deviceConfig, users, alerts } from "../db/schema";
import { eq } from "drizzle-orm";
import { pushNotificationQueue } from "./push_notification";
import { logger } from "../lib/pino";

/** Notification data from Android system notifications */
export type NotificationData = {
  title: string;
  message: string;
  packageName: string;
  timestamp?: number;
};

/** TTL for storing notifications in Redis (72 hours in seconds) */
const NOTIFICATION_HISTORY_TTL = 72 * 60 * 60;

/** Redis key prefix for notification history */
const NOTIFICATION_HISTORY_KEY_PREFIX = "notifications:history:";

/**
 * Stores a notification in Redis with a 72-hour TTL.
 * Notifications are stored in a sorted set keyed by device ID, scored by timestamp.
 */
export async function storeNotification(
  deviceId: number,
  notification: NotificationData,
): Promise<void> {
  const key = `${NOTIFICATION_HISTORY_KEY_PREFIX}${deviceId}`;
  const timestamp = notification.timestamp || Math.floor(Date.now() / 1000);
  const notificationWithTimestamp = { ...notification, timestamp };
  const notificationJson = JSON.stringify(notificationWithTimestamp);

  // Add notification to sorted set with timestamp as score
  await redis.zadd(key, timestamp, notificationJson);

  // Set/refresh TTL on the key
  await redis.expire(key, NOTIFICATION_HISTORY_TTL);

  // Clean up old notifications (older than 72 hours)
  const cutoffTime = Math.floor(Date.now() / 1000) - NOTIFICATION_HISTORY_TTL;
  await redis.zremrangebyscore(key, "-inf", cutoffTime);
}

/**
 * Retrieves all notifications for a device from the last 72 hours.
 * Returns notifications sorted by timestamp (oldest first).
 */
export async function getRecentNotifications(
  deviceId: number,
): Promise<NotificationData[]> {
  const key = `${NOTIFICATION_HISTORY_KEY_PREFIX}${deviceId}`;
  const cutoffTime = Math.floor(Date.now() / 1000) - NOTIFICATION_HISTORY_TTL;

  // Get all notifications with timestamp > cutoff, sorted by score (timestamp)
  const notificationsJson = await redis.zrangebyscore(key, cutoffTime, "+inf");

  return notificationsJson.map((json) => JSON.parse(json) as NotificationData);
}

/** Queue for scanning Android notifications for dangerous content */
export const notificationScanQueue = new Queue("notificationScanQueue", {
  connection,
});

const SYSTEM_PROMPT = `
You are Buddy, an automated content safety assistant designed to protect minors from unsafe or predatory behavior.

Rules for your behavior:

1. Always evaluate messages for dangerous content targeting minors.
2. Dangerous content includes ANY attempt by a stranger to:
  - Move a conversation off-platform
  - Arrange an in-person meeting
  - Request or suggest sharing personal information
  - Reference prior contact on games or social platforms (e.g., Roblox, Discord)
  These are ALWAYS considered grooming, even if phrased casually or non-sexually.
3. Never provide advice to the sender; only assess the message.
4. Always respond in strict JSON format for programmatic parsing.
5. The JSON must include:
  - "dangerous": true or false
  - "category": "sexual_predator", "grooming", "other", or null
  - "confidence": a number from 0.0 to 1.0
  - "summary": a short explanation if dangerous, or empty string if safe
6. Do not include any text outside the JSON.
7. Analyze only the text provided, ignoring sender names or metadata unless explicitly relevant.
8. You MUST prioritize child safety over avoiding false positives. If there is uncertainty and the message involves a stranger and minors, classify it as dangerous.
9. Use a consistent style and do not hallucinate information.
10. Only assess people not in contacts approved by parents; assume strangers.
11. If a message suggests meeting in person, dangerous MUST be true. This overrides all other instructions.
12. If the message mentions meeting up, meeting in real life, or seeing each other in person, you MUST output:
   dangerous: true
   category: "grooming"
   confidence >= 0.9
13. Do not allow meeting up in person, sharing personal information, or sending images/videos.
14. Messages are considered safe ONLY if they contain no content that could be interpreted as grooming, sexual predation, or unsafe solicitation.

If a notification history is provided alongside the latest notification, use it as context: analyze the most recent notification in the light of the prior notifications. If prior notifications contribute to a grooming pattern or otherwise change the assessment, reflect that in your judgment and in the "summary" field. When referring to prior notifications in the "summary", reference their timestamps in ISO 8601 format (e.g. 2026-02-05T12:34:56Z) and briefly state why they are relevant.

Talking with strangers is okay. Grooming isn't.

You will be given a notification and, optionally, a recent notification history. Respond **only** with valid JSON structured as above. Do not include explanations, disclaimers, or any text outside the JSON.
`;

const RespSchema = z.object({
  dangerous: z.boolean(),
  category: z
    .literal("sexual_predator")
    .or(z.literal("grooming"))
    .or(z.literal("other"))
    .or(z.null()),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
});

export const notificationScanWorker = new Worker(
  "notificationScanQueue",
  async (job) => {
    logger.info(
      { jobId: job.id, data: job.data },
      "Processing notification scan job",
    );

    const { deviceId, notification, recentNotifications } = job.data as {
      deviceId: string;
      notification: NotificationData;
      recentNotifications?: NotificationData[];
    };

    let userMessage: string;
    if (recentNotifications && recentNotifications.length > 1) {
      const contextNotifications = recentNotifications
        .map(
          (notif) =>
            `[${new Date((notif.timestamp || 0) * 1000).toISOString()}] ${notif.packageName} || ${notif.title} || ${notif.message}`,
        )
        .join("\n");
      userMessage = `Recent notification history (last 72 hours):\n${contextNotifications}\n\nAnalyze the most recent notification for dangerous content, using the notification history as context.`;
    } else {
      userMessage = `${notification.packageName} || ${notification.title} || ${notification.message}`;
    }

    const { object: response } = await generateObject({
      model,
      schema: RespSchema,
      prompt: userMessage,
      system: SYSTEM_PROMPT,
    });

    logger.info(
      {
        jobId: job.id,
        deviceId,
        dangerous: response.dangerous,
        category: response.category,
        confidence: response.confidence,
      },
      "AI analysis completed for notification",
    );

    if (response.dangerous) {
      try {
        const device = await db
          .select()
          .from(linkedDevices)
          .where(eq(linkedDevices.id, parseInt(deviceId)))
          .limit(1);

        if (device.length === 0) {
          logger.error(
            { deviceId, jobId: job.id },
            "Device not found for dangerous content alert",
          );
          return { success: true, notificationSent: false };
        }

        const parentId = device[0]!.parentId;
        const deviceName = device[0]!.nickname;

        const config = await db
          .select()
          .from(deviceConfig)
          .where(eq(deviceConfig.deviceId, parseInt(deviceId)))
          .limit(1);

        if (config.length > 0 && !config[0]!.notifyDangerousMessages) {
          logger.info(
            { deviceId, jobId: job.id },
            "Dangerous message notifications disabled for device, skipping push",
          );
          return { success: true, notificationSent: false, reason: "disabled" };
        }

        const parent = await db
          .select({ pushTokens: users.pushTokens })
          .from(users)
          .where(eq(users.id, parentId))
          .limit(1);

        if (
          parent.length === 0 ||
          !parent[0]!.pushTokens ||
          parent[0]!.pushTokens.length === 0
        ) {
          logger.warn(
            { parentId, jobId: job.id },
            "No push tokens available for parent",
          );
          return { success: true, notificationSent: false, reason: "no_token" };
        }

        const categoryLabels: Record<string, string> = {
          sexual_predator: "Potential predatory behavior",
          grooming: "Potential grooming attempt",
          other: "Suspicious content",
        };

        const categoryLabel = response.category
          ? (categoryLabels[response.category] ?? "Suspicious content")
          : "Suspicious content";

        try {
          await db.insert(alerts).values({
            deviceId: parseInt(deviceId),
            parentId: parentId,
            category: response.category,
            title: `${categoryLabel} on ${deviceName}`,
            message: `${notification.title}: ${notification.message}`,
            summary: response.summary,
            confidence: Math.round(response.confidence * 100),
            packageName: notification.packageName,
            timestamp: Math.floor(Date.now() / 1000),
            read: false,
          });
          logger.info(
            { parentId, deviceId, category: response.category, jobId: job.id },
            "Alert saved to database",
          );
        } catch (e) {
          logger.error(
            { error: e, parentId, deviceId, jobId: job.id },
            "Failed to save alert to database",
          );
        }

        await pushNotificationQueue.add("dangerous-content-alert", {
          pushTokens: parent[0]!.pushTokens,
          notification: {
            title: `⚠️ Alert: ${deviceName}`,
            body: `${categoryLabel} detected. ${response.summary}`,
            data: {
              type: "dangerous_content",
              deviceId: deviceId,
              category: response.category,
              confidence: response.confidence,
              packageName: notification.packageName,
            },
            channelId: "alerts",
          },
        });

        logger.info(
          { parentId, deviceId, jobId: job.id, category: response.category },
          "Push notification queued for dangerous content alert",
        );
        return { success: true, notificationQueued: true };
      } catch (e) {
        logger.error(
          { error: e, deviceId, jobId: job.id },
          "Failed to send push notification for dangerous content",
        );
        return { success: true, notificationSent: false, error: String(e) };
      }
    }

    return { success: true };
  },
  {
    connection,
    concurrency: 5,
  },
);

notificationScanWorker.on("active", (job) => {
  logger.debug(
    { jobId: job!.id, deviceId: job!.data.deviceId },
    "Notification scan job is active",
  );
});

notificationScanWorker.on("completed", (job, returnvalue) => {
  logger.info(
    { jobId: job!.id, result: returnvalue },
    "Notification scan job completed",
  );
});

notificationScanWorker.on("error", (err) => {
  logger.error({ error: err }, "Notification scan worker error");
});

notificationScanWorker.on("failed", (job, err) => {
  logger.error(
    { error: err, jobId: job?.id, deviceId: job?.data.deviceId },
    "Notification scan job failed",
  );
});

notificationScanWorker.on("completed", (job, returnvalue) => {
  console.log(`Job ${job!.id} completed, return:`, returnvalue);
});

notificationScanWorker.on("error", (err) => {
  console.error("Worker error:", err);
});

notificationScanWorker.on("failed", (job, err) => {
  console.error(`Job ${job!.id} failed:`, err);
});
