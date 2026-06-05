import { NextRequest, NextResponse } from "next/server";
import { getCurrentAdmin } from "@/lib/auth";
import { resolveClipPath } from "@/lib/clipping";
import fs from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { name: string } },
) {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // decodeURIComponent because the file name may contain spaces / parens.
  const decoded = decodeURIComponent(params.name);
  const full = resolveClipPath(decoded);
  if (!full) {
    return new NextResponse("not found", { status: 404 });
  }

  const stat = fs.statSync(full);
  // Stream the file via a Node Readable -> Web ReadableStream bridge so
  // we don't load the whole MP4 into memory.
  const nodeStream = fs.createReadStream(full);
  const webStream = new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => {
        controller.enqueue(
          chunk instanceof Uint8Array
            ? chunk
            : new Uint8Array(Buffer.from(chunk)),
        );
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${decoded}"`,
      "Cache-Control": "no-store",
    },
  });
}
