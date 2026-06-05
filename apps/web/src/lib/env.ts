import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  WEBHOOK_SECRET: z
    .string()
    .min(16, "WEBHOOK_SECRET must be at least 16 chars"),

  // Used as the HMAC secret for the signed session cookie. Kept the name
  // NEXTAUTH_SECRET for backwards-compat with the previous setup, but the
  // codebase no longer depends on next-auth.
  NEXTAUTH_SECRET: z.string().min(16),

  // Optional. Used as the public URL for callbacks. No longer required
  // (NextAuth had stricter requirements), but kept as informational.
  NEXTAUTH_URL: z.string().url().optional(),

  WEB_PUBLIC_URL: z.string().url().optional(),
});

type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error(
      "Invalid environment variables:",
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
