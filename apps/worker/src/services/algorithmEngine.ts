import FormData from "form-data";
import { z } from "zod";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

const EngineResponseSchema = z.object({
  scores: z.record(z.string(), z.number()),
  summary: z.string().optional(),
});

export type EngineResponse = z.infer<typeof EngineResponseSchema>;

export type ScoreInput = {
  /**
   * A factory that returns a fresh readable stream for the video each time it
   * is called. Required because Node streams are single-use, so per-attempt
   * retries must obtain a new stream. The simplest implementation is a thunk
   * that re-runs `downloadFile(...).stream`.
   */
  streamFactory: () => Promise<NodeJS.ReadableStream> | NodeJS.ReadableStream;
  fileName: string;
  mimeType: string;
  knownLength?: number | null;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

class TransientEngineError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TransientEngineError";
  }
}

/**
 * Deterministic-but-varied mock score generator. Hashes the file name with
 * a simple rolling multiply so every name yields a stable score, but
 * different names yield different scores.
 */
export function mockScores(fileName: string): {
  overall: number;
  clarity: number;
  engagement: number;
} {
  const seed = [...fileName].reduce(
    (a, c) => (a * 31 + c.charCodeAt(0)) >>> 0,
    7,
  );
  function r(i: number) {
    return ((seed * (i + 1)) % 1000) / 1000;
  }
  return {
    overall: Number((0.5 + r(1) * 0.5).toFixed(3)),
    clarity: Number((0.4 + r(2) * 0.6).toFixed(3)),
    engagement: Number((0.3 + r(3) * 0.7).toFixed(3)),
  };
}

/**
 * POST a multipart/form-data video to the configured Algorithm Engine and
 * parse the JSON response. Implements bounded inner retries on 429/5xx; outer
 * BullMQ retries handle longer-term failure. Each retry obtains a fresh stream
 * via `streamFactory` because Node streams are not replayable.
 */
export async function scoreVideo(
  input: ScoreInput,
  opts: { maxAttempts?: number } = {},
): Promise<{ scores: Record<string, number>; raw: unknown }> {
  if (env.ALGO_ENGINE_MOCK) {
    // Drain the stream once so behavior matches reality (the streamFactory
    // typically wraps an upstream Drive download which we want to consume).
    try {
      const stream = await input.streamFactory();
      // Resume to discard any buffered data, end consumes the rest.
      if (typeof (stream as NodeJS.ReadableStream).resume === "function") {
        (stream as NodeJS.ReadableStream).resume();
      }
      // Wait for end so we don't leak handles in tests.
      await new Promise<void>((resolve) => {
        const s = stream as NodeJS.ReadableStream;
        s.on("end", () => resolve());
        s.on("close", () => resolve());
        s.on("error", () => resolve());
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        "mock engine: failed to drain input stream (continuing)",
      );
    }

    const scores = mockScores(input.fileName);
    logger.info(
      { fileName: input.fileName, scores, mock: true },
      "algorithm engine mock scored",
    );
    return {
      scores,
      raw: { mock: true, source: "mock-engine", scores },
    };
  }

  const maxAttempts = opts.maxAttempts ?? 3;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Get a fresh stream for THIS attempt. After a failed attempt the previous
    // stream is consumed/destroyed and cannot be reused.
    const stream = await input.streamFactory();

    const form = new FormData();
    form.append(env.ALGO_ENGINE_FIELD_NAME, stream, {
      filename: input.fileName,
      contentType: input.mimeType,
      knownLength: input.knownLength ?? undefined,
    });

    const headers = {
      ...form.getHeaders(),
      Authorization: `Bearer ${env.ALGO_ENGINE_API_KEY}`,
    };

    try {
      const res = await fetch(env.ALGO_ENGINE_URL, {
        method: "POST",
        headers,
        // form-data exposes a Node stream; fetch in Node accepts it.
        body: form as unknown as BodyInit,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- duplex required for streaming bodies in Node fetch
        duplex: "half" as any,
      });

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get("retry-after");
        const retryMs = retryAfter
          ? Number(retryAfter) * 1000
          : Math.min(30_000, 2 ** attempt * 500);
        // Drain body to free the connection.
        await res.text().catch(() => "");
        throw new TransientEngineError(
          `engine returned ${res.status}`,
          res.status,
          retryMs,
        );
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // Non-retriable: 4xx that isn't 429 means our request is wrong.
        throw new Error(`engine ${res.status}: ${text.slice(0, 500)}`);
      }

      const json = await res.json();
      const parsed = EngineResponseSchema.safeParse(json);
      if (!parsed.success) {
        logger.error(
          { json, err: parsed.error.flatten() },
          "engine response failed schema",
        );
        throw new Error("engine response did not match expected schema");
      }
      return { scores: parsed.data.scores, raw: json };
    } catch (err) {
      lastErr = err;
      const isTransient = err instanceof TransientEngineError;
      // Network/connect errors are also transient; identify by name.
      const isNetwork =
        err instanceof TypeError ||
        (err instanceof Error && /fetch|network|ECONN|ETIMED/i.test(err.message));

      if ((isTransient || isNetwork) && attempt < maxAttempts) {
        const retryMs =
          isTransient && err.retryAfterMs != null
            ? err.retryAfterMs
            : Math.min(30_000, 2 ** attempt * 500);
        logger.warn(
          { err: err instanceof Error ? err.message : err, attempt, retryMs },
          "engine call transient failure, retrying with fresh stream",
        );
        await sleep(retryMs);
        continue;
      }
      throw err;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("engine call failed");
}
