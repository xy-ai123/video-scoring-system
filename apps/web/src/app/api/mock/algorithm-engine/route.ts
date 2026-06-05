/**
 * In-process mock Algorithm Engine.
 *
 * Useful for exercising the real HTTP path during local dev without standing
 * up a separate service:
 *
 *   ALGO_ENGINE_URL=http://localhost:3000/api/mock/algorithm-engine
 *   ALGO_ENGINE_API_KEY=anything
 *   ALGO_ENGINE_MOCK=false
 *
 * Accepts multipart/form-data with a "video" field (configurable via
 * ALGO_ENGINE_FIELD_NAME on the worker) and returns deterministic scores
 * derived from the uploaded filename — so the same file always scores the
 * same, but different filenames get different scores.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mockScores(fileName: string): {
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

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "expected multipart/form-data" },
      { status: 400 },
    );
  }

  // The worker uses ALGO_ENGINE_FIELD_NAME (default "video"). Look at common
  // candidates so we don't 400 on a misconfigured field name in dev.
  const candidate =
    form.get("video") ?? form.get("file") ?? form.get("upload");

  if (!candidate) {
    return NextResponse.json(
      { error: "missing 'video' field in form data" },
      { status: 400 },
    );
  }

  const fileName =
    candidate instanceof File && candidate.name
      ? candidate.name
      : "unknown.mp4";

  const scores = mockScores(fileName);

  return NextResponse.json({
    scores,
    summary: "mock score",
    mock: true,
  });
}
