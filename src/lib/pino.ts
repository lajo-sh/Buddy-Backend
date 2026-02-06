import pino from "pino";
import type { LokiOptions } from "pino-loki";

let transport;

if (process.env.NODE_ENV === "production") {
  transport = pino.transport<LokiOptions>({
    target: "pino-loki",
    options: {
      host: process.env.LOKI_HOST!,
      basicAuth: {
        username: process.env.LOKI_USERNAME!,
        password: process.env.LOKI_PASSWORD!,
      },
    },
  });
} else {
  transport = pino.transport({
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  });
}

/** Application-wide logger instance that writes to Loki in production, pretty-prints locally */
export const logger = pino(transport);
