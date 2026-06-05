import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // Reuse the main app's service-account env var. The hand-off folder must
  // be shared with this account (Viewer is enough for read-only listing).
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),

  // Folder that holds clipped + (eventually) labelled videos.
  HANDOFF_DRIVE_FOLDER_ID: z
    .string()
    .min(1)
    .default("1Jdse6zWG9RKYlJaxYonVqM5gsSv2cx4M"),

  // Algorithm engine (not ready yet). When unset / mocked / pointing at
  // the .env.example placeholder, the dashboard surfaces a "not
  // configured yet" banner and the route returns a friendly stub.
  ALGO_ENGINE_URL: z.string().url().optional(),
  ALGO_ENGINE_API_KEY: z.string().optional(),
  ALGO_ENGINE_MOCK: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true" || v === "1"),

  // Same secret as the main web app, so the session cookie set on either
  // app is accepted on the other. (Both run on localhost during dev so
  // the cookie domain is shared.)
  NEXTAUTH_SECRET: z.string().min(16),

  // Local-dev escape hatch identical to apps/web.
  AUTH_BYPASS: z.string().optional(),
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
