import nodemailer from "nodemailer";
import { logger } from "../lib/pino";

let transporter: nodemailer.Transporter | null = null;

/**
 * Gets or creates the nodemailer transporter instance.
 * Configuration is loaded from SMTP environment variables.
 */
export function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    try {
      if (!process.env.SMTP_HOST) {
        logger.error("SMTP_HOST environment variable not set");
        throw new Error("SMTP_HOST is required");
      }

      if (!process.env.SMTP_PORT) {
        logger.error("SMTP_PORT environment variable not set");
        throw new Error("SMTP_PORT is required");
      }

      if (!process.env.SMTP_USER) {
        logger.error("SMTP_USER environment variable not set");
        throw new Error("SMTP_USER is required");
      }

      if (!process.env.SMTP_PASS) {
        logger.error("SMTP_PASS environment variable not set");
        throw new Error("SMTP_PASS is required");
      }

      const port = Number(process.env.SMTP_PORT);
      if (isNaN(port) || port <= 0 || port > 65535) {
        logger.error(
          { port: process.env.SMTP_PORT },
          "Invalid SMTP_PORT value",
        );
        throw new Error("SMTP_PORT must be a valid port number");
      }

      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE == "1",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      logger.info(
        {
          host: process.env.SMTP_HOST,
          port,
          secure: process.env.SMTP_SECURE == "1",
        },
        "Email transporter created successfully",
      );
    } catch (error) {
      logger.error({ error }, "Failed to create email transporter");
      throw error;
    }
  }
  return transporter;
}
