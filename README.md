# Video Scoring System

A production-ready monorepo that automates video scoring from Google Form submissions. When a user submits a video to your Google Form, the system downloads it from Drive, sends it to an Algorithm Engine for scoring, and lets admins approve or reject results — sending the submitter a Resend email on approval.

## Architecture

```
+-----------------+       +---------------------------+        +------------------+
| Google Form     |       | apps/web (Next.js)        |        | Postgres         |
|  +              | HMAC  |  - NextAuth (Google)      |        |  Submissions     |
| Apps Script     |------>|  - /api/webhooks/google-  |<------>|  VideoFiles      |
|  onFormSubmit   |       |    form                   |        |  Scores          |
+-----------------+       |  - /admin dashboard       |        |  AuditLog        |
                          |  - /api/submissions/...   |        +------------------+
                          +-----------+---------------+
                                      | enqueue
                                      v
                          +---------------------------+
                          | Redis (BullMQ)            |
                          |  - scoring queue          |
                          |  - notifications queue    |
                          +-----------+---------------+
                                      |
                                      v
                          +---------------------------+        +------------------+
                          | apps/worker (Node)        |        | Google Drive     |
                          |  - downloads from Drive   |<------>|  Service Account |
                          |  - posts multipart to     |        +------------------+
                          |    ALGO_ENGINE_URL        |        +------------------+
                          |  - persists Scores        |<------>| Algorithm Engine |
                          |  - sends Resend emails    |        +------------------+
                          +---------------------------+        +------------------+
                                                               | Resend           |
                                                               +------------------+
```

## Quick start with mocks (no external services)

You can run the entire pipeline locally without GCP, the Algorithm Engine, Resend, or Google OAuth.

1. Copy `.env.example` to `.env`. The default values already enable all four `*_MOCK` flags.
2. Start Postgres + Redis (Docker recommended; example below).
3. `pnpm install`
4. `pnpm db:generate && pnpm db:migrate`
5. In two terminals: `pnpm dev:web` and `pnpm dev:worker`.
6. Trigger a synthetic submission: `pnpm test:webhook --email=demo-admin@example.com --name="Demo User" --category=cooking --files=1`
7. Open http://localhost:3000/admin, sign in with `demo-admin@example.com` (no Google needed in mock mode), watch the submission flow PENDING -> SCORING -> SCORED. Click Approve and watch the worker logs print the (mocked) email.

Sample docker-compose for Postgres+Redis:

```yaml
services:
  db: { image: postgres:16-alpine, environment: { POSTGRES_PASSWORD: postgres, POSTGRES_DB: video_scoring }, ports: ['5432:5432'] }
  redis: { image: redis:7-alpine, ports: ['6379:6379'] }
```

The four mock flags:

| Flag                | Effect when `true`                                                |
|---------------------|-------------------------------------------------------------------|
| `AUTH_MOCK`         | Replaces Google OAuth with a Credentials provider on `/login`.    |
| `DRIVE_MOCK`        | Worker `downloadFile` returns a 1KB in-memory stream.             |
| `ALGO_ENGINE_MOCK`  | Worker `scoreVideo` returns deterministic mock scores.            |
| `RESEND_MOCK`       | Worker logs the approval email instead of POSTing to Resend.      |

If you want to exercise the Algorithm Engine HTTP path without the real
service, leave `ALGO_ENGINE_MOCK=false` and point the worker at the
in-process mock engine bundled with the web app:

```
ALGO_ENGINE_URL=http://localhost:3000/api/mock/algorithm-engine
ALGO_ENGINE_API_KEY=anything
```

## What I need from you

> These are NOT required for mock mode. Provide real values when you want to swap a mock for the real service. Items 1-9 from the original list are skippable while `*_MOCK` flags are on.

To stand this system up in production, please provide / configure the following. Without these, the system cannot function.

1. **Google account with access to the target Form.** The form whose submissions trigger the workflow. You will edit its bound Apps Script project.
2. **Google Cloud Project with a Service Account.** Create a new Service Account (or reuse one), generate a JSON key, and base64-encode the entire JSON file. The encoded string becomes the `GOOGLE_SERVICE_ACCOUNT_JSON` env var. Enable the Google Drive API on the project.
3. **Share the Form's response Drive folder with the Service Account email.** Open the Drive folder Google Forms places uploads into, click Share, and grant the Service Account email (`...@<project>.iam.gserviceaccount.com`) **Viewer** access. Without this the worker cannot download videos.
4. **The form ID** (from the form URL) and, only if you need to read responses directly, the response sheet ID. The system does not require the sheet ID — Apps Script reads responses directly from the Form.
5. **Apps Script deployment.** In the Form, open `⋮` -> `Script editor`. Paste `apps-script/Code.gs` and `apps-script/appsscript.json` into the project. Set Script Properties:
   - `WEBHOOK_URL` — public URL of the deployed web app, ending with `/api/webhooks/google-form`
   - `WEBHOOK_SECRET` — the same value as the `WEBHOOK_SECRET` env var on the server
   - `FIELD_EMAIL`, `FIELD_NAME`, `FIELD_CATEGORY`, `FIELD_VIDEO` — exact titles of the relevant form items
   Then install the `onFormSubmit` trigger: Triggers (clock icon) -> Add trigger -> Function: `onFormSubmit`, Event source: `From form`, Event type: `On form submit`.
6. **Algorithm Engine details.**
   - Base URL (`ALGO_ENGINE_URL`) — the full URL the worker will POST multipart/form-data to.
   - API key (`ALGO_ENGINE_API_KEY`) — sent as `Authorization: Bearer <key>`.
   - The multipart field name (`ALGO_ENGINE_FIELD_NAME`, defaults to `video`).
   - Expected JSON response shape: by default we expect `{ scores: { [metric: string]: number }, summary?: string }`. If yours differs, tell us so we can adjust the parser in `apps/worker/src/services/algorithmEngine.ts`.
7. **Resend API key + verified sender domain.** Set `RESEND_API_KEY` and `RESEND_FROM` (e.g. `Video Scoring <noreply@yourdomain.com>`).
8. **Google OAuth credentials for admin login.** Create an OAuth 2.0 Client ID in Google Cloud Console (Web application). Set authorized redirect URI to `${NEXTAUTH_URL}/api/auth/callback/google`. Provide `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
9. **Comma-separated admin email allowlist.** Set `ADMIN_EMAILS=alice@example.com,bob@example.com`. Only these emails can sign in to the dashboard.
10. **Railway deployment.**
    - Create a Railway project.
    - Add a **Postgres** plugin -> copy the connection string into `DATABASE_URL`.
    - Add a **Redis** plugin -> copy the connection string into `REDIS_URL`.
    - Create a **Web service** from this repo. Root: `/`. Use `Dockerfile.web` or Nixpacks (see `railway.json`). Set all env vars from `.env.example` plus `WEB_PUBLIC_URL` to the Railway-generated public URL. Set `NEXTAUTH_URL` to the same value.
    - Create a **Worker service** from this repo. Use `Dockerfile.worker`. No public domain. Set the same env vars (DATABASE_URL, REDIS_URL, GOOGLE_SERVICE_ACCOUNT_JSON, ALGO_ENGINE_*, RESEND_*, WEB_PUBLIC_URL, LOG_LEVEL).
    - First deploy: run `pnpm -F @vss/db db:deploy` once to apply migrations (Railway run command, or temporarily change web service start command).

## Local development

```bash
pnpm i
cp .env.example .env
# fill in .env with your values

# Start Postgres & Redis (use docker, brew, or local installs).

pnpm db:generate
pnpm db:migrate

# In two terminals:
pnpm dev:web      # http://localhost:3000
pnpm dev:worker
```

To expose your local web app to Apps Script for end-to-end testing, run **`./scripts/tunnel.sh`** and set `WEBHOOK_URL` in Apps Script Script Properties to the tunnel URL (see below).

## Putting the dashboard online (without redeploying)

Why not Railway? **Dashboard 1's `/admin/clipping` page shells out to the
Python pipeline at `~/robot-video-pipeline/`** (MediaPipe, ffmpeg, the
OAuth `token.json`, the local `clips/` folder). That pipeline can't run
on a Railway container. If you push the dashboard to Railway, the
clipping feature breaks. Railway makes sense for the Form-submission
worker (apps/worker) — not for Dashboard 1.

Why not "HTML"? The app is full-stack — API routes, Postgres, Prisma,
BullMQ, signed-cookie auth, Python subprocess. There's no way to make it
a static site.

**The honest trade-off:** for HTTP tunneling you can't get *free +
stable URL + no account* at once. Pick two:

| Option | Cost | URL stable? | Setup |
|---|---|---|---|
| **Cloudflare quick tunnel** *(default — what `tunnel.sh` does)* | free | ❌ new URL each restart | none — `brew install cloudflared` once |
| **Tailscale Funnel** *(recommended upgrade)* | free | ✅ permanent | Tailscale account + 5 min |
| **Cloudflare named tunnel** | free | ✅ permanent | needs your own domain |

### Default: Cloudflare quick tunnel

```bash
brew install cloudflared      # one-time
pnpm dev:web                  # terminal 1 — dashboard on :3000
./scripts/tunnel.sh           # terminal 2 — tunnel
```

The script prints a big banner with the public URL when it's ready and
also writes it to `.tunnel-url` at the project root, so you can always
find the current address with:

```bash
cat .tunnel-url
# https://trusts-scanning-pledge-elevation.trycloudflare.com
open "$(cat .tunnel-url)/admin/clipping"
```

For port 3001 (Dashboard 2): `./scripts/tunnel.sh 3001`.

**Caveat:** every restart of `tunnel.sh` gives a NEW random URL. If you
care about bookmarks not breaking, do the Tailscale upgrade below.

**Shortcut — skip the bookmark and just open the current URL:**

```bash
./scripts/open-dashboard.sh          # opens /admin/clipping in your browser
./scripts/open-dashboard.sh /login   # any path
```

The script reads `.tunnel-url` (rewritten by `tunnel.sh` every start) and
calls `open`. Use this instead of bookmarks and you'll never hit a stale
URL again.

**Or: bookmark a self-updating local HTML file.** `tunnel.sh` now
generates `dashboard.html` at the project root every time it starts.
The file has a `<meta http-equiv="refresh">` tag pointing at whatever
the current cloudflared URL is. Bookmark the **`file://`** path once
(or use the `VideoScoring Dashboard.webloc` icon I dropped on your
Desktop) — every click opens the current dashboard, even after the
underlying URL rotates:

```bash
open "$(pwd)/dashboard.html"  # equivalent to clicking the bookmark
```

### Permanent URL (optional upgrade): Tailscale Funnel

Tailscale Funnel gives a **stable `*.ts.net` URL** that survives reboots
and tunnel restarts. Free for personal use, no domain required.

```bash
brew install --cask tailscale            # install
open -a Tailscale                         # launch, click "Log in"

# After signing in (Google/GitHub/etc.):
tailscale funnel --bg 3000               # exposes :3000 publicly
tailscale funnel status                  # prints your permanent URL
```

The URL looks like `https://<machine>.<tailnet>.ts.net`. Bookmark it once
and you're done forever.

## Pushing this repo to GitHub

Tunneling and GitHub are independent — the tunnel only exposes the
running dev server. To put the source code on GitHub:

```bash
# from the project root (the folder containing this README):
git init
git add -A
git commit -m "Initial commit"

# create a repo on github.com (private recommended for the .env etc.),
# then:
git remote add origin git@github.com:<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

The existing `.gitignore` already excludes `.env`, `node_modules`, and
build artefacts. **Double-check that `.env` is NOT staged** before your
first commit — it contains secrets:

```bash
git status            # .env must NOT appear under "Changes to be committed"
git ls-files | grep '\.env$'   # must be empty
```

## Adding a new admin

Add the email to the `ADMIN_EMAILS` env var (comma separated) and redeploy the web service. The change takes effect on next sign-in. There is no in-app user management — the allowlist is the source of truth, intentionally.

## Repo layout

```
apps/
  web/        Dashboard 1 — submissions + /admin/clipping (split unclipped|clipped)
  web-algo/   Dashboard 2 — hand-off folder listing + algorithm-engine wiring
  worker/     BullMQ workers for scoring + notification
packages/
  db/         Prisma schema + generated client (shared)
apps-script/
  Code.gs, appsscript.json — Google Apps Script source for onFormSubmit
```

## The two dashboards

### Dashboard 1 — Clipping (`apps/web`, port 3000)

- `/admin` — original submissions table (PENDING → SCORED → APPROVED).
- `/admin/clipping` — **NEW**: split view, raw videos on the left,
  clipped MP4s on the right. The "Run clipping now" button shells out
  to the Python pipeline at `$ROBOT_PIPELINE_PATH` and runs:
  1. `pull_from_drive.py` — scans **all of My Drive** for video files
     (excluding the hand-off folder) and downloads new ones into
     `incoming/`. Pass `--folder <ID>` to restrict scope.
  2. `detect_hands.py` — MediaPipe detects hand activity, ffmpeg cuts
     CVAT-ready MP4s (H.264 + AAC + `+faststart`) into `clips/`.
  3. `upload_clips_to_drive.py` — pushes clips into the hand-off Drive
     folder (`HANDOFF_DRIVE_FOLDER_ID`), tracked in `pipeline.db`.
- Each clipped row has a Download button (streams the local MP4) and
  either "On Drive" (uploaded) or "Upload" (push now).
- Requires the dashboard to run on the same machine as the Python
  pipeline. Set `ROBOT_PIPELINE_PATH` if not at `~/robot-video-pipeline`.

### Dashboard 2 — Algorithm engine (`apps/web-algo`, port 3001)

- Lists the contents of `HANDOFF_DRIVE_FOLDER_ID` (the same folder
  Dashboard 1 uploads into).
- "Send to engine" button hits `POST /api/algo/run`, which currently
  returns a friendly "engine not configured yet" message.
- When the engine is ready: set `ALGO_ENGINE_URL` + `ALGO_ENGINE_API_KEY`
  and port the multipart POST from
  `apps/worker/src/services/algorithmEngine.ts` into
  `apps/web-algo/src/lib/algoEngine.ts`.

**Important — run from the project directory, not your home folder.** All
`pnpm` commands must be executed inside the `video-scoring-system/` checkout
(the folder that contains the top-level `package.json`).

```bash
# from your terminal, FIRST cd into the project:
cd /path/to/video-scoring-system     # e.g. ~/Projects/video-scoring-system

# one-time setup: make sure each app sees the root .env
[ -f apps/web/.env       ] || ln -s ../../.env apps/web/.env
[ -f apps/web-algo/.env  ] || ln -s ../../.env apps/web-algo/.env

# then, in 3 separate terminals (each with cwd = project root):
pnpm dev:web        # Dashboard 1 on http://localhost:3000
pnpm dev:web-algo   # Dashboard 2 on http://localhost:3001
pnpm dev:worker     # BullMQ worker (Form-submitted videos)
```

Both dashboards share the same signed-cookie session
(`NEXTAUTH_SECRET`), so logging in at :3000 also authenticates :3001.

Why the `.env` symlinks? Next.js loads `.env` from each app's own folder
(`apps/web/`, `apps/web-algo/`), not the monorepo root. Symlinking keeps
both apps pointed at the single source-of-truth file at the repo root —
edit `.env` once and both apps pick it up.

## Useful commands

| Command | What it does |
|---|---|
| `pnpm dev:web` | Run Next.js in dev mode |
| `pnpm dev:worker` | Run worker with tsx watch |
| `pnpm build` | Build all packages |
| `pnpm db:migrate` | Create + apply a new Prisma migration locally |
| `pnpm db:deploy` | Apply migrations in production |
| `pnpm db:generate` | Regenerate Prisma client |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm typecheck` | Type-check every workspace |
| `pnpm lint` | Lint every workspace |

## Security notes

- The webhook is HMAC-protected. Apps Script signs the JSON body with `WEBHOOK_SECRET`; the server rejects mismatched signatures with 401.
- Webhook is idempotent: dedupe is by `responseId` (Form response ID).
- All admin REST endpoints require an authenticated session whose email is in `ADMIN_EMAILS`.
- Service-account JSON is stored base64-encoded in env to avoid newline issues.

## License

MIT
