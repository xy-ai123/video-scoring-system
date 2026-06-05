import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { listHandoffFolder } from "@/lib/drive";
import { AlgoDashboard } from "./AlgoDashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AlgoHomePage() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    // Bounce to apps/web's login page — same cookie, same secret.
    redirect("http://localhost:3000/login?from=algo");
  }

  let files: Awaited<ReturnType<typeof listHandoffFolder>> = [];
  let loadError: string | null = null;
  try {
    files = await listHandoffFolder(env.HANDOFF_DRIVE_FOLDER_ID);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  // Treat the engine as "configured" only if the URL is set AND it isn't
  // the placeholder from .env.example AND ALGO_ENGINE_MOCK isn't on.
  const url = env.ALGO_ENGINE_URL ?? "";
  const placeholderRe = /your-algorithm-engine|example\.(com|org|net)/i;
  const engineConfigured =
    url.length > 0 && !placeholderRe.test(url) && !env.ALGO_ENGINE_MOCK;

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Algorithm Dashboard
          </h1>
          <p className="text-sm text-slate-500">
            Clipped + labelled videos from the hand-off Drive folder.
            Send to the algorithm engine when it's online.
          </p>
        </div>
        <div className="text-xs text-slate-400">
          <div>
            Folder:{" "}
            <a
              href={`https://drive.google.com/drive/folders/${env.HANDOFF_DRIVE_FOLDER_ID}`}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline"
            >
              {env.HANDOFF_DRIVE_FOLDER_ID}
            </a>
          </div>
          <div>
            Engine: {engineConfigured ? url : "(not configured)"}
          </div>
        </div>
      </header>

      {loadError ? (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          <strong>Could not list Drive folder.</strong> {loadError}
        </div>
      ) : null}

      <AlgoDashboard files={files} engineConfigured={engineConfigured} />
    </main>
  );
}
