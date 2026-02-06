import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";
import { logger } from "../lib/pino";
import { redisCache } from "./redis/cache";
import { redis } from "./redis/client";

logger.info("Initializing database connection...");

/** Main database instance with Redis caching and query logging */
export const db = drizzle(process.env.DATABASE_URL!, {
  schema,
  cache: redisCache({ global: true, defaultTtl: 120, redis }),
  logger: {
    logQuery: (query, params) => {
      logger.debug({ query, params }, "Database query executed");
    },
  },
});

logger.info("Database connection initialized");
