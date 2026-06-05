/**
 * Placeholder wrapper for the Algorithm Engine.
 *
 * When ALGO_ENGINE_URL is unset, every call returns { ok: false,
 * reason: 'not-configured' } so the dashboard can render a "engine not
 * ready yet" state without crashing.
 *
 * When ready: implement the multipart POST + JSON-response shape parser.
 * Mirror apps/worker/src/services/algorithmEngine.ts for the real path.
 */

import { env } from "./env";

export type AlgoResult =
  | {
      ok: true;
      scores: Record<string, number>;
      summary?: string;
    }
  | {
      ok: false;
      reason: "not-configured" | "engine-error";
      message: string;
    };

function isPlaceholderUrl(url: string | undefined): boolean {
  if (!url) return true;
  // Match the .env.example placeholder + any obvious example domain.
  return /your-algorithm-engine|example\.(com|org|net)/i.test(url);
}

export async function scoreDriveFile(_fileId: string): Promise<AlgoResult> {
  if (
    !env.ALGO_ENGINE_URL ||
    env.ALGO_ENGINE_MOCK ||
    isPlaceholderUrl(env.ALGO_ENGINE_URL)
  ) {
    return {
      ok: false,
      reason: "not-configured",
      message:
        "Algorithm Engine not configured yet. Set ALGO_ENGINE_URL " +
        "(replace the placeholder), ALGO_ENGINE_API_KEY, and " +
        "ALGO_ENGINE_MOCK=false in .env, then implement the multipart " +
        "POST in apps/web-algo/src/lib/algoEngine.ts.",
    };
  }
  // Real implementation goes here. Left intentionally unimplemented per
  // the user's scope ("not ready yet").
  return {
    ok: false,
    reason: "engine-error",
    message:
      "ALGO_ENGINE_URL is set but the wiring isn't implemented in this build. " +
      "Port apps/worker/src/services/algorithmEngine.ts when you're ready.",
  };
}
