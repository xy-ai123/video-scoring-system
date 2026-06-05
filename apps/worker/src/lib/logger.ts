import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

const REDACT_PATHS = [
  // googleapis Axios errors carry the bearer token here
  "err.config.headers.authorization",
  "err.config.headers.Authorization",
  // common secrets that might end up in a log payload
  "*.password",
  "*.GMAIL_SMTP_PASSWORD",
  "*.WEBHOOK_SECRET",
  "*.NEXTAUTH_SECRET",
  "*.GOOGLE_SERVICE_ACCOUNT_JSON",
  "req.headers.authorization",
  "req.headers.cookie",
  "*.cookie",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "worker" },
  redact: { paths: REDACT_PATHS, remove: true },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            singleLine: true,
            translateTime: "SYS:HH:MM:ss",
          },
        },
      }
    : {}),
});

export type Logger = typeof logger;
