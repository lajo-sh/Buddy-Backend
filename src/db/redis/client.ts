import Redis from "ioredis";
import { connection } from "./info";

/** Redis client instance for caching and session management */
export const redis = new Redis({
  host: connection.host,
  port: connection.port,
  password: connection.password,
  db: connection.db,
});
