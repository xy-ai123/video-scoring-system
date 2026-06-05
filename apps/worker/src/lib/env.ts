import { z } from "zod";

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v === "true");

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("production"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    // Made optional; required iff DRIVE_MOCK is false.
    GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional().default(""),

    // Made optional; required iff ALGO_ENGINE_MOCK is false.
    // We accept any string (or empty) and validate URL shape in superRefine
    // only when the mock is off, so dev .env can leave the placeholder in.
    ALGO_ENGINE_URL: z.string().optional().default(""),
    ALGO_ENGINE_API_KEY: z.string().optional().default(""),
    ALGO_ENGINE_FIELD_NAME: z.string().min(1).default("video"),

    // Made optional; required iff RESEND_MOCK is false.
    RESEND_API_KEY: z.string().optional().default(""),
    RESEND_FROM: z.string().optional().default(""),

    WEB_PUBLIC_URL: z.string().url().optional(),

    // --- Gmail API (Workspace DWD) ---
    // Email of a Workspace user that the service account impersonates when
    // sending. Empty => Gmail-DWD backend disabled. Cannot be a @gmail.com
    // consumer account — DWD only works with Workspace.
    GMAIL_IMPERSONATE_USER: z.string().optional().default(""),
    // Optional display name in the From header. The address is always the
    // impersonated user's (Gmail-DWD) or GMAIL_SMTP_USER (SMTP).
    GMAIL_FROM_NAME: z.string().optional().default(""),

    // --- Gmail SMTP (App Password, works with consumer @gmail.com accounts) ---
    // The full Gmail address that owns the App Password.
    GMAIL_SMTP_USER: z.string().optional().default(""),
    // The 16-char App Password (NOT the account password). Generate at
    // https://myaccount.google.com/apppasswords — requires 2FA on the account.
    GMAIL_SMTP_PASSWORD: z.string().optional().default(""),

    // --- Decision log Google Sheet ---
    // Sheet ID where each approve/reject decision is recorded as a row.
    // Empty string disables sheet logging (the email path still runs).
    SHEET_ID: z.string().optional().default(""),
    // Name of the tab within the spreadsheet to write to. Empty = first tab.
    // Set this when your spreadsheet has multiple tabs (e.g. a hidden
    // "Form Responses 1" tab from a previous Forms link).
    SHEET_TAB: z.string().optional().default(""),

    // --- Mock mode flags ---
    DRIVE_MOCK: boolFromString,
    ALGO_ENGINE_MOCK: boolFromString,
    RESEND_MOCK: boolFromString,
  })
  .superRefine((val, ctx) => {
    if (!val.DRIVE_MOCK && !val.GOOGLE_SERVICE_ACCOUNT_JSON) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GOOGLE_SERVICE_ACCOUNT_JSON"],
        message:
          "GOOGLE_SERVICE_ACCOUNT_JSON is required unless DRIVE_MOCK=true",
      });
    }
    if (!val.ALGO_ENGINE_MOCK) {
      if (!val.ALGO_ENGINE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ALGO_ENGINE_URL"],
          message:
            "ALGO_ENGINE_URL is required unless ALGO_ENGINE_MOCK=true",
        });
      } else {
        try {
          new URL(val.ALGO_ENGINE_URL);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["ALGO_ENGINE_URL"],
            message: "ALGO_ENGINE_URL must be a valid URL",
          });
        }
      }
      if (!val.ALGO_ENGINE_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ALGO_ENGINE_API_KEY"],
          message:
            "ALGO_ENGINE_API_KEY is required unless ALGO_ENGINE_MOCK=true",
        });
      }
    }
    // Email backends: at least one of (Gmail SMTP, Gmail DWD, Resend) must be
    // configured unless RESEND_MOCK=true.
    const gmailDwdConfigured =
      Boolean(val.GMAIL_IMPERSONATE_USER) &&
      Boolean(val.GOOGLE_SERVICE_ACCOUNT_JSON);
    const gmailSmtpConfigured =
      Boolean(val.GMAIL_SMTP_USER) && Boolean(val.GMAIL_SMTP_PASSWORD);
    const gmailConfigured = gmailDwdConfigured || gmailSmtpConfigured;
    if (!val.RESEND_MOCK && !gmailConfigured) {
      if (!val.RESEND_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["RESEND_API_KEY"],
          message:
            "Configure an email backend: GMAIL_SMTP_USER+GMAIL_SMTP_PASSWORD (App Password), GMAIL_IMPERSONATE_USER (Workspace DWD), or RESEND_API_KEY. Or set RESEND_MOCK=true to skip sending in dev.",
        });
      }
      if (!val.RESEND_FROM) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["RESEND_FROM"],
          message:
            "RESEND_FROM is required when using Resend. Use the Gmail backends instead by setting GMAIL_SMTP_* or GMAIL_IMPERSONATE_USER.",
        });
      }
    }
  });

type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error(
      "Invalid worker environment variables:",
      parsed.error.flatten().fieldErrors,
    );
    throw new Error("Invalid environment variables");
  }
  cached = parsed.data;
  return cached;
}

export const env = new Proxy({} as Env, {
  get(_, prop: string) {
    return getEnv()[prop as keyof Env];
  },
});
