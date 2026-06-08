/**
 * Resolves each Submission's immediate-parent Drive folder name (e.g.
 * "VPM0166") to its top-level "main" folder (e.g. "Hotel 77") by
 * spawning the worker's `dumpDriveMains.ts` once and caching the result
 * for ~5 minutes.
 *
 * Why a subprocess? The worker package owns the Drive client; pulling
 * googleapis into apps/web would bloat the dashboard bundle. Spawning
 * also keeps cold-start cost off the request path after the first
 * page load.
 *
 * Cache invalidation: TTL only. Triggering a `Sync Drive` run from the
 * admin button doesn't reach in here, but the TTL keeps things fresh
 * for normal use. Worst case: a brand-new top-level folder appears in
 * Drive and clips under it bucket as "Other" for up to 5 minutes.
 */

// Plain (no `node:` prefix). When Next.js's instrumentation hook
// triggers a build pass that webpack handles via the Edge fallback,
// `node:` URIs trip UnhandledSchemeError even though this file only
// runs in Node. Plain names compile cleanly and are functionally
// identical at runtime.
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

type MainsPayload = {
  /** Map from immediate-parent folder name → top-level main name. */
  subFolderNameToMain: Record<string, string>;
  /** Distinct main names that currently bucket at least one sub. */
  knownMains: string[];
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const COMPUTE_TIMEOUT_MS = 60 * 1000;

let cache: { builtAt: number; payload: MainsPayload } | null = null;
let inflight: Promise<MainsPayload> | null = null;

function repoRoot(): string {
  const fromEnv = process.env.MONOREPO_ROOT;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.resolve(process.cwd(), "..", "..");
}

function workerDir(): string {
  return path.join(repoRoot(), "apps", "worker");
}

function emptyPayload(): MainsPayload {
  return { subFolderNameToMain: {}, knownMains: [] };
}

function runDumpScript(): Promise<MainsPayload> {
  const tsx = path.join(workerDir(), "node_modules", ".bin", "tsx");
  const script = path.join(workerDir(), "src", "scripts", "dumpDriveMains.ts");
  if (!fs.existsSync(tsx) || !fs.existsSync(script)) {
    // Pipeline isn't installed in this environment — degrade gracefully
    // so the dashboard still loads with everything under "Other".
    return Promise.resolve(emptyPayload());
  }

  return new Promise<MainsPayload>((resolve) => {
    const child = spawn(tsx, [script], {
      cwd: workerDir(),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, COMPUTE_TIMEOUT_MS);

    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.warn("[driveMains] dumpDriveMains failed:", stderr.slice(0, 400));
        resolve(emptyPayload());
        return;
      }
      // The script ALSO writes pino logs to stderr if anything misfires;
      // its only stdout line is the JSON. We parse the last non-empty
      // line to be safe.
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      if (!last) {
        resolve(emptyPayload());
        return;
      }
      try {
        const obj = JSON.parse(last) as Partial<MainsPayload>;
        resolve({
          subFolderNameToMain: obj.subFolderNameToMain ?? {},
          knownMains: obj.knownMains ?? [],
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[driveMains] could not parse dump output:",
          err instanceof Error ? err.message : String(err),
        );
        resolve(emptyPayload());
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      // eslint-disable-next-line no-console
      console.warn("[driveMains] spawn error:", err.message);
      resolve(emptyPayload());
    });
  });
}

export async function getDriveMains(): Promise<MainsPayload> {
  const now = Date.now();
  if (cache && now - cache.builtAt < CACHE_TTL_MS) {
    return cache.payload;
  }
  if (inflight) return inflight;
  inflight = runDumpScript().then((payload) => {
    cache = { builtAt: Date.now(), payload };
    inflight = null;
    return payload;
  });
  return inflight;
}

/**
 * Force the next caller to recompute. Called after Sync Drive completes
 * so a freshly-added main folder appears immediately, not after 5 min.
 */
export function invalidateDriveMains(): void {
  cache = null;
}
