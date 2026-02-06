import { logger } from "../../lib/pino";

const port = Number(process.env.REDIS_PORT);
const db = Number(process.env.REDIS_DB || 0);

logger.info(
  { host: process.env.REDIS_HOST, port, db },
  "Configuring Redis connection",
);

/** Redis connection configuration loaded from environment variables */
export const connection = {
  host: process.env.REDIS_HOST!,
  port,
  password: process.env.REDIS_PASSWORD!,
  db,
};

logger.info("Redis connection configuration complete");
