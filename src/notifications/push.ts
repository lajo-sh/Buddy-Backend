import Expo, { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import { logger } from "../lib/pino";

/** Expo SDK client for sending push notifications */
let expo: Expo;
try {
  expo = new Expo();
  logger.info("Expo push notification client initialized");
} catch (error) {
  logger.fatal({ error }, "Failed to initialize Expo push notification client");
  throw error;
}

/** Data structure for push notification payloads */
export type PushNotificationData = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  badge?: number;
  channelId?: string;
};

/**
 * Sends a push notification to one device.
 * Validates the token format and notification data before sending.
 */
export async function sendPushNotification(
  pushToken: string,
  notification: PushNotificationData,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!pushToken || typeof pushToken !== "string") {
      logger.warn("Invalid push token: empty or not a string");
      return { success: false, error: "Invalid push token" };
    }

    if (!notification || typeof notification !== "object") {
      logger.error({ pushToken }, "Invalid notification data");
      return { success: false, error: "Invalid notification data" };
    }

    if (!notification.title || !notification.body) {
      logger.error({ pushToken }, "Notification missing title or body");
      return { success: false, error: "Notification must have title and body" };
    }

    if (!Expo.isExpoPushToken(pushToken)) {
      logger.warn({ pushToken }, "Invalid Expo push token format");
      return { success: false, error: "Invalid push token" };
    }

    const message: ExpoPushMessage = {
      to: pushToken,
      sound: notification.sound ?? "default",
      title: notification.title,
      body: notification.body,
      data: notification.data ?? {},
      channelId: notification.channelId ?? "default",
    };

    if (notification.badge !== undefined) {
      message.badge = notification.badge;
    }

    try {
      const tickets = await expo.sendPushNotificationsAsync([message]);
      const ticket = tickets[0];

      if (!ticket) {
        logger.error({ pushToken }, "No ticket returned from Expo");
        return { success: false, error: "No ticket returned" };
      }

      if (ticket.status === "error") {
        logger.error(
          { pushToken, error: ticket.message },
          "Push notification error from Expo",
        );
        return { success: false, error: ticket.message };
      }

      logger.info(
        { pushToken, ticketId: (ticket as { id: string }).id },
        "Push notification sent successfully",
      );
      return { success: true };
    } catch (error) {
      logger.error(
        { error, pushToken },
        "Failed to send push notification to Expo",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  } catch (error) {
    logger.error(
      { error, pushToken },
      "Unexpected error in sendPushNotification",
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Sends push notifications to multiple devices in batches.
 * Filters out invalid tokens and chunks requests to avoid rate limits.
 */
export async function sendPushNotifications(
  pushTokens: string[],
  notification: PushNotificationData,
): Promise<{ success: boolean; results: ExpoPushTicket[] }> {
  try {
    if (!Array.isArray(pushTokens)) {
      logger.error("pushTokens is not an array");
      return { success: false, results: [] };
    }

    if (pushTokens.length === 0) {
      logger.warn("Empty pushTokens array provided");
      return { success: false, results: [] };
    }

    if (!notification || typeof notification !== "object") {
      logger.error(
        { tokenCount: pushTokens.length },
        "Invalid notification data for bulk send",
      );
      return { success: false, results: [] };
    }

    if (!notification.title || !notification.body) {
      logger.error(
        { tokenCount: pushTokens.length },
        "Bulk notification missing title or body",
      );
      return { success: false, results: [] };
    }

    const validTokens = pushTokens.filter((token) => {
      const isValid = Expo.isExpoPushToken(token);
      if (!isValid) {
        logger.warn(
          { token },
          "Invalid Expo push token in bulk send, filtering out",
        );
      }
      return isValid;
    });

    if (validTokens.length === 0) {
      logger.warn(
        { originalCount: pushTokens.length },
        "No valid tokens after filtering",
      );
      return { success: false, results: [] };
    }

    logger.info(
      {
        validTokenCount: validTokens.length,
        totalTokenCount: pushTokens.length,
      },
      "Sending bulk push notifications",
    );

    const messages: ExpoPushMessage[] = validTokens.map((token) => ({
      to: token,
      sound: notification.sound ?? "default",
      title: notification.title,
      body: notification.body,
      data: notification.data ?? {},
      channelId: notification.channelId ?? "default",
    }));

    try {
      const chunks = expo.chunkPushNotifications(messages);
      const tickets: ExpoPushTicket[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk!);
          tickets.push(...ticketChunk);
          logger.debug(
            {
              chunkIndex: i,
              chunkSize: chunk!.length,
              totalChunks: chunks.length,
            },
            "Push notification chunk sent",
          );
        } catch (chunkError) {
          logger.error(
            { error: chunkError, chunkIndex: i, chunkSize: chunk!.length },
            "Failed to send push notification chunk",
          );
        }
      }

      const errorTickets = tickets.filter(
        (ticket) => ticket.status === "error",
      );
      const hasErrors = errorTickets.length > 0;

      if (hasErrors) {
        logger.warn(
          { errorCount: errorTickets.length, totalCount: tickets.length },
          "Some push notifications failed",
        );
        errorTickets.forEach((ticket) => {
          if (ticket.status === "error") {
            logger.error(
              { error: ticket.message, details: ticket.details },
              "Push notification ticket error",
            );
          }
        });
      } else {
        logger.info(
          { sentCount: tickets.length },
          "All push notifications sent successfully",
        );
      }

      return { success: !hasErrors, results: tickets };
    } catch (error) {
      logger.error(
        { error, tokenCount: validTokens.length },
        "Failed to send bulk push notifications",
      );
      return { success: false, results: [] };
    }
  } catch (error) {
    logger.error({ error }, "Unexpected error in sendPushNotifications");
    return { success: false, results: [] };
  }
}

/** Checks whether a token string is a valid Expo push token */
export function isValidPushToken(token: string): boolean {
  return Expo.isExpoPushToken(token);
}
