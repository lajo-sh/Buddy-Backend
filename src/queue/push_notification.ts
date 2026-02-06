import { Queue, Worker } from "bullmq";
import { connection } from "../db/redis/info";
import {
  sendPushNotifications,
  PushNotificationData,
} from "../notifications/push";
import { logger } from "../lib/pino";

/** Job data for sending push notifications to multiple devices */
export type PushNotificationJob = {
  pushTokens: string[];
  notification: PushNotificationData;
};

/** Queue for batching and sending push notifications to parents */
export const pushNotificationQueue = new Queue<PushNotificationJob>(
  "pushNotificationQueue",
  {
    connection,
  },
);

/** Worker that processes push notification jobs and sends them via Expo */
export const pushNotificationWorker = new Worker<PushNotificationJob>(
  "pushNotificationQueue",
  async (job) => {
    const { pushTokens, notification } = job.data;

    try {
      if (!Array.isArray(pushTokens)) {
        logger.error(
          { jobId: job.id },
          "pushTokens is not an array in job data",
        );
        throw new Error("Invalid pushTokens");
      }

      if (pushTokens.length === 0) {
        logger.warn({ jobId: job.id }, "Empty pushTokens array in job");
        return { success: false, sent: 0, reason: "No tokens" };
      }

      if (!notification || typeof notification !== "object") {
        logger.error({ jobId: job.id }, "Invalid notification data in job");
        throw new Error("Invalid notification data");
      }

      if (!notification.title || !notification.body) {
        logger.error(
          { jobId: job.id },
          "Notification missing title or body in job",
        );
        throw new Error("Notification must have title and body");
      }

      logger.info(
        {
          jobId: job.id,
          tokenCount: pushTokens.length,
          title: notification.title,
        },
        "Processing push notification job",
      );

      const result = await sendPushNotifications(pushTokens, notification);

      logger.info(
        {
          jobId: job.id,
          success: result.success,
          sent: result.results.length,
          tokenCount: pushTokens.length,
        },
        "Push notifications sent",
      );

      return { success: result.success, sent: result.results.length };
    } catch (error) {
      logger.error(
        { error, jobId: job.id, tokenCount: pushTokens?.length },
        "Failed to send push notifications in job",
      );
      throw error;
    }
  },
  {
    connection,
    concurrency: 10,
  },
);

pushNotificationWorker.on("active", (job) => {
  logger.debug(
    { jobId: job!.id, tokenCount: job!.data.pushTokens.length },
    "Push notification job is active",
  );
});

pushNotificationWorker.on("completed", (job, returnvalue) => {
  logger.info(
    { jobId: job!.id, result: returnvalue },
    "Push notification job completed",
  );
});

pushNotificationWorker.on("error", (err) => {
  logger.error({ error: err }, "Push notification worker error");
});

pushNotificationWorker.on("failed", (job, err) => {
  logger.error(
    { error: err, jobId: job?.id, tokenCount: job?.data.pushTokens?.length },
    "Push notification job failed",
  );
});
