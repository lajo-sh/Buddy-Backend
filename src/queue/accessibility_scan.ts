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

/** Message data captured from accessibility services on child devices */
export type AccessibilityMessageData = {
  app: string;
  sender: string;
  message: string;
  timestamp: number;
};

/** TTL for storing accessibility messages in Redis (72 hours in seconds) */
const MESSAGE_HISTORY_TTL = 72 * 60 * 60;

/** Redis key prefix for accessibility message history */
const MESSAGE_HISTORY_KEY_PREFIX = "accessibility:messages:";

/**
 * Stores an accessibility message in Redis with a 72-hour TTL.
 * Messages are stored in a sorted set keyed by device ID, scored by timestamp.
 */
export async function storeAccessibilityMessage(
  deviceId: number,
  message: AccessibilityMessageData,
): Promise<void> {
  const key = `${MESSAGE_HISTORY_KEY_PREFIX}${deviceId}`;
  const messageJson = JSON.stringify(message);

  // Add message to sorted set with timestamp as score
  await redis.zadd(key, message.timestamp, messageJson);

  // Set/refresh TTL on the key
  await redis.expire(key, MESSAGE_HISTORY_TTL);

  // Clean up old messages (older than 72 hours)
  const cutoffTime = Math.floor(Date.now() / 1000) - MESSAGE_HISTORY_TTL;
  await redis.zremrangebyscore(key, "-inf", cutoffTime);
}

/**
 * Retrieves all accessibility messages for a device from the last 72 hours.
 * Returns messages sorted by timestamp (oldest first).
 */
export async function getRecentAccessibilityMessages(
  deviceId: number,
): Promise<AccessibilityMessageData[]> {
  const key = `${MESSAGE_HISTORY_KEY_PREFIX}${deviceId}`;
  const cutoffTime = Math.floor(Date.now() / 1000) - MESSAGE_HISTORY_TTL;

  // Get all messages with timestamp > cutoff, sorted by score (timestamp)
  const messagesJson = await redis.zrangebyscore(key, cutoffTime, "+inf");

  return messagesJson.map(
    (json) => JSON.parse(json) as AccessibilityMessageData,
  );
}

/** Queue for scanning accessibility messages for dangerous content */
export const accessibilityScanQueue = new Queue("accessibilityScanQueue", {
  connection,
});

const SYSTEM_PROMPT = `
You are Buddy, an automated content safety assistant designed to protect minors from unsafe or predatory behavior.

You are analyzing messages captured from messaging apps (WhatsApp, Signal, SimpleX) via accessibility services.

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

If a conversation history is provided alongside the latest message, use it as context: analyze the most recent message in the light of the prior messages. If prior messages contribute to a grooming pattern or otherwise change the assessment, reflect that in your judgment and in the "summary" field. When referring to prior messages in the "summary", reference their timestamps in ISO 8601 format (e.g. 2026-02-05T12:34:56Z) and briefly state why they are relevant.

Talking with strangers is okay. Grooming isn't. As long as communication stays online and no personal info is shared, it's safe.
Be deterministic. No history of predatory behavior.

You will be given messages and, optionally, a recent conversation history. Respond **only** with valid JSON structured as above. Do not include explanations, disclaimers, or any text outside the JSON.
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

/** Worker that analyzes accessibility messages using AI to detect dangerous content */
export const accessibilityScanWorker = new Worker(
  "accessibilityScanQueue",
  async (job) => {
    logger.info(
      { jobId: job.id, data: job.data },
      "Processing accessibility message scan job",
    );

    const { deviceId, accessibilityMessage, recentMessages } = job.data as {
      deviceId: string;
      accessibilityMessage: AccessibilityMessageData;
      recentMessages?: AccessibilityMessageData[];
    };

    // Build context from recent messages (last 72 hours)
    let userMessage: string;
    if (recentMessages && recentMessages.length > 1) {
      const contextMessages = recentMessages
        .map(
          (msg) =>
            `[${new Date(msg.timestamp * 1000).toISOString()}] ${msg.app} || From: ${msg.sender} || ${msg.message}`,
        )
        .join("\n");
      userMessage = `Recent conversation history (last 72 hours):\n${contextMessages}\n\nAnalyze the most recent message for dangerous content, using the conversation history as context.`;
    } else {
      userMessage = `${accessibilityMessage.app} || From: ${accessibilityMessage.sender} || ${accessibilityMessage.message}`;
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
        app: accessibilityMessage.app,
        dangerous: response.dangerous,
        category: response.category,
        confidence: response.confidence,
      },
      "AI analysis completed for accessibility message",
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
            "Device not found for dangerous accessibility message alert",
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
            message: `${accessibilityMessage.app} - ${accessibilityMessage.sender}: ${accessibilityMessage.message}`,
            summary: response.summary,
            confidence: Math.round(response.confidence * 100),
            packageName: accessibilityMessage.app,
            timestamp: Math.floor(Date.now() / 1000),
            read: false,
          });
          logger.info(
            { parentId, deviceId, category: response.category, jobId: job.id },
            "Accessibility alert saved to database",
          );
        } catch (e) {
          logger.error(
            { error: e, parentId, deviceId, jobId: job.id },
            "Failed to save accessibility alert to database",
          );
        }

        await pushNotificationQueue.add("dangerous-accessibility-alert", {
          pushTokens: parent[0]!.pushTokens,
          notification: {
            title: `⚠️ Alert: ${deviceName}`,
            body: `${categoryLabel} detected in ${accessibilityMessage.app}. ${response.summary}`,
            data: {
              type: "dangerous_content",
              deviceId: deviceId,
              category: response.category,
              confidence: response.confidence,
              packageName: accessibilityMessage.app,
              sender: accessibilityMessage.sender,
            },
            channelId: "alerts",
          },
        });

        logger.info(
          {
            parentId,
            deviceId,
            jobId: job.id,
            category: response.category,
            app: accessibilityMessage.app,
          },
          "Push notification queued for dangerous accessibility message alert",
        );
        return { success: true, notificationQueued: true };
      } catch (e) {
        logger.error(
          { error: e, deviceId, jobId: job.id },
          "Failed to send push notification for dangerous accessibility message",
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

accessibilityScanWorker.on("active", (job) => {
  logger.debug(
    { jobId: job!.id, deviceId: job!.data.deviceId },
    "Accessibility scan job is active",
  );
});

accessibilityScanWorker.on("completed", (job, returnvalue) => {
  logger.info(
    { jobId: job!.id, result: returnvalue },
    "Accessibility scan job completed",
  );
});

accessibilityScanWorker.on("error", (err) => {
  logger.error({ error: err }, "Accessibility scan worker error");
});

accessibilityScanWorker.on("failed", (job, err) => {
  logger.error(
    { error: err, jobId: job?.id, deviceId: job?.data.deviceId },
    "Accessibility scan job failed",
  );
});
