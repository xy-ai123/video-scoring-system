import pino from "pino";

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
  base: { service: "web" },
  redact: { paths: REDACT_PATHS, remove: true },
});

export type Logger = typeof logger;
